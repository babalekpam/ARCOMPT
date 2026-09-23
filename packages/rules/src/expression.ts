// SPDX-FileCopyrightText: © ARGILETTE LLC — ARCOMPT, plateforme comptable OHADA (arcompt.com)
// SPDX-License-Identifier: LicenseRef-ARGILETTE-Proprietary
/**
 * Interpréteur d'expressions déclaratives pour les packs pays.
 *
 * Grammaire (précédence croissante) :
 *   expr     := or
 *   or       := and ("or" and)*
 *   and      := not ("and" not)*
 *   not      := "not" not | cmp
 *   cmp      := add (("<" | "<=" | ">" | ">=" | "==" | "!=") add)?
 *   add      := mul (("+" | "-") mul)*
 *   mul      := unary (("*" | "/") unary)*
 *   unary    := "-" unary | primary
 *   primary  := number | identifier | identifier "(" args ")" | "(" expr ")" | "true" | "false"
 *
 * Les nombres sont des décimaux exacts (bigint à 10 décimales) : jamais de
 * flottants. Un pack ne contient jamais de code : seules les fonctions
 * enregistrées ici sont appelables.
 */

export type Value = Decimal | boolean | Bareme;

export interface BaremeTranche {
  /** Borne supérieure de la tranche (incluse) ; absente = dernière tranche. */
  upTo?: string;
  /** Taux appliqué à la partie de la base comprise dans la tranche. */
  rate: string;
}

export interface Bareme {
  kind: "bareme";
  tranches: BaremeTranche[];
}

export const DEC_SCALE = 10;
const DEC_FACTOR = 10n ** BigInt(DEC_SCALE);

/** Décimal exact à 10 décimales. */
export class Decimal {
  private constructor(readonly raw: bigint) {}

  static of(input: string | number | bigint | Decimal): Decimal {
    if (input instanceof Decimal) return input;
    if (typeof input === "bigint") return new Decimal(input * DEC_FACTOR);
    const text = (typeof input === "number" ? input.toString() : input).trim().replace(",", ".");
    const m = /^([+-])?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!m) throw new RuleError(`Nombre invalide : "${input}"`);
    let frac = m[3] ?? "";
    let whole = m[2] ?? "0";
    const exp = m[4] ? Number(m[4]) : 0;
    if (exp !== 0) {
      const digits = whole + frac;
      const point = whole.length + exp;
      if (point <= 0) {
        whole = "0";
        frac = "0".repeat(-point) + digits;
      } else if (point >= digits.length) {
        whole = digits + "0".repeat(point - digits.length);
        frac = "";
      } else {
        whole = digits.slice(0, point);
        frac = digits.slice(point);
      }
    }
    if (frac.length > DEC_SCALE) throw new RuleError(`Trop de décimales (max ${DEC_SCALE}) : "${input}"`);
    const sign = m[1] === "-" ? -1n : 1n;
    return new Decimal(sign * (BigInt(whole) * DEC_FACTOR + BigInt((frac + "0".repeat(DEC_SCALE)).slice(0, DEC_SCALE))));
  }

  static fromRaw(raw: bigint): Decimal {
    return new Decimal(raw);
  }

  add(o: Decimal): Decimal {
    return new Decimal(this.raw + o.raw);
  }
  sub(o: Decimal): Decimal {
    return new Decimal(this.raw - o.raw);
  }
  mul(o: Decimal): Decimal {
    return new Decimal(divRound(this.raw * o.raw, DEC_FACTOR));
  }
  div(o: Decimal): Decimal {
    if (o.raw === 0n) throw new RuleError("Division par zéro");
    return new Decimal(divRound(this.raw * DEC_FACTOR, o.raw));
  }
  neg(): Decimal {
    return new Decimal(-this.raw);
  }
  cmp(o: Decimal): -1 | 0 | 1 {
    return this.raw < o.raw ? -1 : this.raw > o.raw ? 1 : 0;
  }
  min(o: Decimal): Decimal {
    return this.cmp(o) <= 0 ? this : o;
  }
  max(o: Decimal): Decimal {
    return this.cmp(o) >= 0 ? this : o;
  }
  isZero(): boolean {
    return this.raw === 0n;
  }
  /** Arrondi arithmétique à n décimales (n peut être négatif : -3 = au millier). */
  round(decimals = 0): Decimal {
    const step = 10n ** BigInt(DEC_SCALE - decimals);
    return new Decimal(divRound(this.raw, step) * step);
  }
  floor(decimals = 0): Decimal {
    const step = 10n ** BigInt(DEC_SCALE - decimals);
    const q = this.raw / step;
    const r = this.raw % step;
    return new Decimal((r < 0n ? q - 1n : q) * step);
  }
  ceil(decimals = 0): Decimal {
    const step = 10n ** BigInt(DEC_SCALE - decimals);
    const q = this.raw / step;
    const r = this.raw % step;
    return new Decimal((r > 0n ? q + 1n : q) * step);
  }
  toString(): string {
    const neg = this.raw < 0n;
    const abs = neg ? -this.raw : this.raw;
    const whole = abs / DEC_FACTOR;
    const frac = (abs % DEC_FACTOR).toString().padStart(DEC_SCALE, "0").replace(/0+$/, "");
    return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
  }
  toJSON(): string {
    return this.toString();
  }
}

function divRound(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= (b < 0n ? -b : b)) return (a < 0n) !== (b < 0n) ? q - 1n : q + 1n;
  return q;
}

export class RuleError extends Error {
  override name = "RuleError";
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------
type Token =
  | { t: "num"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "(" }
  | { t: ")" }
  | { t: "," }
  | { t: "eof" };

const OPS = ["<=", ">=", "==", "!=", "<", ">", "+", "-", "*", "/"];

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|^[0-9]+\.?/.exec(src.slice(i));
      if (!m) throw new RuleError(`Nombre invalide à la position ${i}`);
      out.push({ t: "num", v: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    if (c === "(") {
      out.push({ t: "(" });
      i++;
      continue;
    }
    if (c === ")") {
      out.push({ t: ")" });
      i++;
      continue;
    }
    if (c === ",") {
      out.push({ t: "," });
      i++;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ t: "op", v: op });
      i += op.length;
      continue;
    }
    throw new RuleError(`Caractère inattendu « ${c} » à la position ${i}`);
  }
  out.push({ t: "eof" });
  return out;
}

// ---------------------------------------------------------------------------
// Parser → AST
// ---------------------------------------------------------------------------
export type Ast =
  | { k: "num"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "var"; name: string }
  | { k: "call"; name: string; args: Ast[] }
  | { k: "unary"; op: "-" | "not"; e: Ast }
  | { k: "bin"; op: string; l: Ast; r: Ast };

export function parse(src: string): Ast {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos]!;
  const next = () => toks[pos++]!;
  const isOp = (v: string) => {
    const t = peek();
    return t.t === "op" && t.v === v;
  };
  const isId = (v: string) => {
    const t = peek();
    return t.t === "id" && t.v === v;
  };

  function expr(): Ast {
    return or();
  }
  function or(): Ast {
    let l = and();
    while (isId("or")) {
      next();
      l = { k: "bin", op: "or", l, r: and() };
    }
    return l;
  }
  function and(): Ast {
    let l = not();
    while (isId("and")) {
      next();
      l = { k: "bin", op: "and", l, r: not() };
    }
    return l;
  }
  function not(): Ast {
    if (isId("not")) {
      next();
      return { k: "unary", op: "not", e: not() };
    }
    return cmp();
  }
  function cmp(): Ast {
    const l = add();
    for (const op of ["<=", ">=", "==", "!=", "<", ">"]) {
      if (isOp(op)) {
        next();
        return { k: "bin", op, l, r: add() };
      }
    }
    return l;
  }
  function add(): Ast {
    let l = mul();
    while (isOp("+") || isOp("-")) {
      const op = (next() as { v: string }).v;
      l = { k: "bin", op, l, r: mul() };
    }
    return l;
  }
  function mul(): Ast {
    let l = unary();
    while (isOp("*") || isOp("/")) {
      const op = (next() as { v: string }).v;
      l = { k: "bin", op, l, r: unary() };
    }
    return l;
  }
  function unary(): Ast {
    if (isOp("-")) {
      next();
      return { k: "unary", op: "-", e: unary() };
    }
    return primary();
  }
  function primary(): Ast {
    const t = next();
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "(") {
      const e = expr();
      if (next().t !== ")") throw new RuleError("Parenthèse fermante attendue");
      return e;
    }
    if (t.t === "id") {
      if (t.v === "true") return { k: "bool", v: true };
      if (t.v === "false") return { k: "bool", v: false };
      if (peek().t === "(") {
        next();
        const args: Ast[] = [];
        if (peek().t !== ")") {
          args.push(expr());
          while (peek().t === ",") {
            next();
            args.push(expr());
          }
        }
        if (next().t !== ")") throw new RuleError(`Parenthèse fermante attendue après ${t.v}(`);
        return { k: "call", name: t.v, args };
      }
      return { k: "var", name: t.v };
    }
    throw new RuleError(`Expression invalide (token ${JSON.stringify(t)})`);
  }

  const ast = expr();
  if (peek().t !== "eof") throw new RuleError(`Texte inattendu après l'expression : ${JSON.stringify(peek())}`);
  return ast;
}

// ---------------------------------------------------------------------------
// Évaluation
// ---------------------------------------------------------------------------
export type Scope = Record<string, Value | string | number | boolean | undefined>;

type Fn = (args: Value[]) => Value;

const D = (v: Value, ctx: string): Decimal => {
  if (v instanceof Decimal) return v;
  throw new RuleError(`${ctx} : nombre attendu`);
};

/** Fonctions autorisées dans les packs. Aucune autre n'est appelable. */
export const BUILTINS: Record<string, Fn> = {
  min: (a) => a.map((v) => D(v, "min")).reduce((x, y) => x.min(y)),
  max: (a) => a.map((v) => D(v, "max")).reduce((x, y) => x.max(y)),
  abs: ([a]) => (D(a!, "abs").cmp(Decimal.of(0)) < 0 ? D(a!, "abs").neg() : D(a!, "abs")),
  round: ([a, n]) => D(a!, "round").round(n === undefined ? 0 : Number(D(n, "round").toString())),
  floor: ([a, n]) => D(a!, "floor").floor(n === undefined ? 0 : Number(D(n, "floor").toString())),
  ceil: ([a, n]) => D(a!, "ceil").ceil(n === undefined ? 0 : Number(D(n, "ceil").toString())),
  /** if(cond, a, b) : les deux branches sont évaluées (pas d'effet de bord possible). */
  if: ([c, a, b]) => {
    if (typeof c !== "boolean") throw new RuleError("if : condition booléenne attendue");
    return c ? a! : b!;
  },
  /** tranche(base, bareme) : impôt progressif par tranches (barème marginal). */
  tranche: ([base, bareme]) => {
    const b = D(base!, "tranche");
    if (!isBareme(bareme)) throw new RuleError("tranche : barème attendu en second argument");
    let total = Decimal.of(0);
    let lower = Decimal.of(0);
    for (const t of bareme.tranches) {
      const upper = t.upTo === undefined ? null : Decimal.of(t.upTo);
      const cap = upper === null ? b : b.min(upper);
      const slice = cap.sub(lower);
      if (slice.cmp(Decimal.of(0)) <= 0) break;
      total = total.add(slice.mul(Decimal.of(t.rate)));
      if (upper === null || b.cmp(upper) <= 0) break;
      lower = upper;
    }
    return total;
  },
  /** taux_tranche(base, bareme) : taux applicable à la tranche où tombe la base (barème non cumulatif). */
  taux_tranche: ([base, bareme]) => {
    const b = D(base!, "taux_tranche");
    if (!isBareme(bareme)) throw new RuleError("taux_tranche : barème attendu");
    for (const t of bareme.tranches) {
      if (t.upTo === undefined || b.cmp(Decimal.of(t.upTo)) <= 0) return Decimal.of(t.rate);
    }
    return Decimal.of(0);
  },
  /** pct(x, taux) = x * taux / 100 */
  pct: ([x, r]) => D(x!, "pct").mul(D(r!, "pct")).div(Decimal.of(100)),
};

export function isBareme(v: unknown): v is Bareme {
  return typeof v === "object" && v !== null && (v as Bareme).kind === "bareme" && Array.isArray((v as Bareme).tranches);
}

function toValue(v: Scope[string], name: string): Value {
  if (v === undefined) throw new RuleError(`Variable inconnue : ${name}`);
  if (typeof v === "string" || typeof v === "number") return Decimal.of(v);
  return v as Value;
}

export function evaluate(ast: Ast, scope: Scope, fns: Record<string, Fn> = BUILTINS): Value {
  switch (ast.k) {
    case "num":
      return Decimal.of(ast.v);
    case "bool":
      return ast.v;
    case "var":
      return toValue(scope[ast.name], ast.name);
    case "call": {
      const fn = fns[ast.name];
      if (!fn) throw new RuleError(`Fonction inconnue : ${ast.name}`);
      return fn(ast.args.map((a) => evaluate(a, scope, fns)));
    }
    case "unary": {
      const v = evaluate(ast.e, scope, fns);
      if (ast.op === "-") return D(v, "-").neg();
      if (typeof v !== "boolean") throw new RuleError("not : booléen attendu");
      return !v;
    }
    case "bin": {
      if (ast.op === "and" || ast.op === "or") {
        const l = evaluate(ast.l, scope, fns);
        if (typeof l !== "boolean") throw new RuleError(`${ast.op} : booléen attendu`);
        if (ast.op === "and" && !l) return false;
        if (ast.op === "or" && l) return true;
        const r = evaluate(ast.r, scope, fns);
        if (typeof r !== "boolean") throw new RuleError(`${ast.op} : booléen attendu`);
        return r;
      }
      const l = evaluate(ast.l, scope, fns);
      const r = evaluate(ast.r, scope, fns);
      if (ast.op === "==" || ast.op === "!=") {
        const eq = l instanceof Decimal && r instanceof Decimal ? l.cmp(r) === 0 : l === r;
        return ast.op === "==" ? eq : !eq;
      }
      const a = D(l, ast.op);
      const b = D(r, ast.op);
      switch (ast.op) {
        case "+":
          return a.add(b);
        case "-":
          return a.sub(b);
        case "*":
          return a.mul(b);
        case "/":
          return a.div(b);
        case "<":
          return a.cmp(b) < 0;
        case "<=":
          return a.cmp(b) <= 0;
        case ">":
          return a.cmp(b) > 0;
        case ">=":
          return a.cmp(b) >= 0;
      }
      throw new RuleError(`Opérateur inconnu : ${ast.op}`);
    }
  }
}

const cache = new Map<string, Ast>();

/** Évalue une expression source dans un scope. L'AST est mis en cache par texte. */
export function evalExpression(src: string, scope: Scope, fns?: Record<string, Fn>): Value {
  let ast = cache.get(src);
  if (!ast) {
    ast = parse(src);
    cache.set(src, ast);
  }
  return evaluate(ast, scope, fns);
}

export function evalNumber(src: string, scope: Scope, fns?: Record<string, Fn>): Decimal {
  const v = evalExpression(src, scope, fns);
  if (!(v instanceof Decimal)) throw new RuleError(`« ${src} » : résultat numérique attendu`);
  return v;
}

export function evalBoolean(src: string, scope: Scope, fns?: Record<string, Fn>): boolean {
  const v = evalExpression(src, scope, fns);
  if (typeof v !== "boolean") throw new RuleError(`« ${src} » : résultat booléen attendu`);
  return v;
}

/** Liste les variables référencées par une expression (validation des packs). */
export function referencedVariables(src: string): string[] {
  const out = new Set<string>();
  const walk = (a: Ast): void => {
    switch (a.k) {
      case "var":
        out.add(a.name);
        break;
      case "call":
        a.args.forEach(walk);
        break;
      case "unary":
        walk(a.e);
        break;
      case "bin":
        walk(a.l);
        walk(a.r);
        break;
    }
  };
  walk(parse(src));
  return [...out].sort();
}
