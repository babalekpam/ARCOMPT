import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Sql } from "postgres";
import type { AuthContext } from "../auth.js";
import {
  aiProviderNames, aiModelVariables, aiEncryptionAvailable, encryptAiSettings, readAiSettings,
  mergeAiSettings, initialAiSettings, configuredAiProvider, AI_PROVIDER_KEYS, resolveAiProviderSelection,
  type StoredAiSettings,
} from "@arcompt/documents";

const provider = z.enum(aiProviderNames);
const model = z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9._:/-]+$/);
const key = z.string().trim().max(4096);
const models = z.object({anthropic:model,openai:model,gemini:model}).strict();
const keys = z.object({anthropic:key.optional(),openai:key.optional(),gemini:key.optional()}).strict();
const saveSchema = z.object({
  revision:z.number().int().nonnegative(),defaultProvider:provider,captureProvider:provider,
  categorizeProvider:provider,models,keys:keys.optional(),
}).strict();
const names = {anthropic:"Claude (Anthropic)",openai:"OpenAI",gemini:"Google Gemini"};

export function platformAiRoutes(db?:Sql,env:NodeJS.ProcessEnv=process.env) {
  const r=new Hono<{Variables:{auth:AuthContext}}>();
  r.use("*",bodyLimit({maxSize:20000}));
  r.use("*",async(c,next)=>{
    c.header("Cache-Control","no-store");
    const a=c.get("auth");
    if(!a.platformAdmin||!a.platformSub)return c.json({error:{code:"FORBIDDEN",message:"Mode super-admin requis."}},403);
    if(!db)return c.json({error:{code:"UNAVAILABLE",message:"Configuration IA indisponible."}},503);
    try {
      if(a.platformMode)await db`SELECT platform_mode_record_access(${a.platformSub},${a.platformMode.sid},${a.platformMode.tokenHash},${a.platformMode.proofHash},NULL,${c.req.method},'/platform/ai')`;
      else await db`SELECT platform_admin_record_access(${a.platformSub},NULL,${c.req.method},'/platform/ai')`;
    } catch {return c.json({error:{code:"FORBIDDEN",message:"Session administrateur expirée."}},403);}
    await next();
  });
  async function state() {
    const row=await readAiSettings(db!,env), current=row.stored??initialAiSettings(env), effective=mergeAiSettings(env,row.stored);
    return {...row,current,effective};
  }
  async function publicState() {
    const s=await state();
    return {revision:s.revision,defaultProvider:s.current.defaultProvider,captureProvider:s.current.captureProvider,categorizeProvider:s.current.categorizeProvider,
      encryptionAvailable:aiEncryptionAvailable(env),
      providers:aiProviderNames.map(p=>({id:p,name:names[p],model:s.current.models[p],configured:!!s.effective[AI_PROVIDER_KEYS[p]]?.trim(),
        source:s.stored?.keys[p]?"stored":env[AI_PROVIDER_KEYS[p]]?.trim()?"environment":"none"}))};
  }
  function validSettings(value:StoredAiSettings|null) {
    const selected=resolveAiProviderSelection(mergeAiSettings(env,value));
    return !selected.simulated && !selected.issues.length;
  }
  async function write(a:AuthContext,revision:number,value:StoredAiSettings|null) {
    const cipher=value ? encryptAiSettings(value,env):null, m=a.platformMode;
    await db!`SELECT platform_ai_save(${a.platformSub!},${m?.sid??null},${m?.tokenHash??null},${m?.proofHash??null},${revision},${cipher})`;
  }
  r.onError((e,c)=>{
    // Never serialize SDK errors, request bodies, ciphertext, or API credentials.
    if("code" in e && e.code==="40001")return c.json({error:{code:"CONFLICT",message:"Configuration modifiée ailleurs. Rechargez avant de réessayer."}},409);
    return c.json({error:{code:"UNAVAILABLE",message:"Configuration IA indisponible. Vérifiez le chiffrement serveur."}},503);
  });
  r.get("/",async c=>c.json(await publicState()));
  r.put("/",async c=>{
    const parsed=saveSchema.safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)return c.json({error:{code:"VALIDATION",message:"Configuration invalide."}},400);
    const s=await state(), b=parsed.data;
    const next:StoredAiSettings={defaultProvider:b.defaultProvider,captureProvider:b.captureProvider,categorizeProvider:b.categorizeProvider,models:b.models,keys:{...s.stored?.keys}};
    for(const p of aiProviderNames)if(b.keys?.[p])next.keys[p]=b.keys[p];
    if(!validSettings(next))return c.json({error:{code:"VALIDATION",message:"Chaque fournisseur sélectionné doit avoir une clé configurée."}},400);
    await write(c.get("auth"),b.revision,next);
    return c.json(await publicState());
  });
  r.delete("/",async c=>{
    const rev=z.coerce.number().int().nonnegative().safeParse(c.req.query("revision"));
    if(!rev.success||c.req.query("revision")===undefined)return c.json({error:{code:"VALIDATION",message:"Révision requise."}},400);
    if(!validSettings(null))return c.json({error:{code:"VALIDATION",message:"La configuration serveur héritée est incomplète. Réinitialisation refusée."}},400);
    await write(c.get("auth"),rev.data,null); return c.json(await publicState());
  });
  r.delete("/providers/:provider",async c=>{
    const p=provider.safeParse(c.req.param("provider")),rev=z.coerce.number().int().nonnegative().safeParse(c.req.query("revision"));
    if(!p.success||!rev.success||c.req.query("revision")===undefined)return c.json({error:{code:"VALIDATION",message:"Fournisseur ou révision invalide."}},400);
    const s=await state(),next={...s.current,keys:{...s.stored?.keys}};
    delete next.keys[p.data];
    if(!validSettings(next))return c.json({error:{code:"VALIDATION",message:"Cette clé est utilisée par un routage actif. Changez le fournisseur avant de la retirer."}},400);
    await write(c.get("auth"),rev.data,next);return c.json(await publicState());
  });
  r.post("/providers/:provider/test",async c=>{
    const p=provider.safeParse(c.req.param("provider")),b=z.object({apiKey:key.optional(),model:model.optional()}).strict().safeParse(await c.req.json().catch(()=>null));
    if(!p.success||!b.success)return c.json({error:{code:"VALIDATION",message:"Demande invalide."}},400);
    const s=await state(),effective={...s.effective};
    if(b.data.apiKey)effective[AI_PROVIDER_KEYS[p.data]]=b.data.apiKey;
    if(b.data.model)effective[aiModelVariables[p.data]]=b.data.model;
    if(!effective[AI_PROVIDER_KEYS[p.data]]?.trim())return c.json({ok:false,message:"Aucune clé configurée pour ce fournisseur."});
    try {
      await configuredAiProvider(p.data,effective).complete({capability:"assistant",promptVersion:"connection-test-v1",system:"Return only the JSON object {\"ok\":true}.",input:{test:true},maxTokens:32});
      return c.json({ok:true,message:"Connexion et modèle vérifiés. Aucun document comptable envoyé."});
    } catch {return c.json({ok:false,message:"Test échoué. Vérifiez la clé, le modèle, les autorisations et le quota du fournisseur."});}
  });
  return r;
}
