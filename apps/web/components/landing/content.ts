import type { Locale } from "@/lib/i18n";

export type LandingCopy = {
  nav: { product: string; method: string; forFirms: string; signIn: string; contact: string; menu: string; navigation: string; home: string };
  hero: {
    eyebrow: string;
    title: string;
    body: string;
    primary: string;
    secondary: string;
    note: string;
  };
  proof: { label: string; items: string[] };
  principle: { kicker: string; title: string; body: string; aside: string };
  workspace: {
    kicker: string;
    title: string;
    body: string;
    labels: { journal: string; balance: string; pending: string; review: string };
  };
  modules: { kicker: string; title: string; body: string; items: { title: string; body: string }[] };
  method: { kicker: string; title: string; body: string; steps: { no: string; title: string; body: string }[] };
  firms: { kicker: string; title: string; body: string; items: string[]; cta: string };
  guardrails: { kicker: string; title: string; body: string; items: string[] };
  close: { title: string; body: string; primary: string; secondary: string };
  footer: { line: string; legal: string; built: string };
};

const fr: LandingCopy = {
  nav: { product: "La plateforme", method: "Notre méthode", forFirms: "Pour les cabinets", signIn: "Se connecter", contact: "Parler à l’équipe", menu: "Menu", navigation: "Navigation principale", home: "Accueil ARCOMPT" },
  hero: {
    eyebrow: "Comptabilité OHADA, avec discernement",
    title: "Les chiffres importants méritent plus qu’un bouton « valider ».",
    body: "ARCOMPT donne aux PME et aux cabinets un espace de travail clair pour tenir, vérifier et expliquer leur comptabilité — dans le respect du cadre SYSCOHADA.",
    primary: "Entrer dans ARCOMPT",
    secondary: "Voir comment nous travaillons",
    note: "Une plateforme en construction sérieuse. Pas une promesse de conformité automatique.",
  },
  proof: { label: "Pensé pour les réalités du terrain", items: ["PME de l’espace OHADA", "Cabinets d’expertise comptable", "Dossiers multi-entités", "Téléphone et ordinateur"] },
  principle: {
    kicker: "Le principe fondateur",
    title: "Automatiser le travail répétitif. Garder le jugement là où il compte.",
    body: "Un montant extrait d’une pièce n’est pas encore une écriture. Un état produit n’est pas encore une décision. ARCOMPT sépare clairement ce qui est proposé, ce qui est contrôlé et ce qui est validé par une personne.",
    aside: "La technologie prépare le dossier. L’humain signe le sens.",
  },
  workspace: {
    kicker: "Un poste de travail, pas une boîte noire",
    title: "Tout ce qui mérite votre attention reste visible.",
    body: "Un grand livre lisible, des pièces rattachées, des opérations en attente et une piste de contrôle qui ne se perd pas dans des menus.",
    labels: { journal: "Journal des opérations", balance: "Balance générale", pending: "À contrôler", review: "Revue humaine" },
  },
  modules: {
    kicker: "Le cœur du quotidien",
    title: "Les bons outils, au même endroit.",
    body: "Chaque module est conçu pour soutenir une pratique comptable réelle, sans maquiller ce qui n’est pas encore disponible.",
    items: [
      { title: "Saisie & journaux", body: "Organisez vos écritures par dossier, journal et exercice. Retrouvez le contexte avant le chiffre." },
      { title: "Pièces & rapprochement", body: "Rattachez les documents aux opérations et signalez ce qui demande une vérification." },
      { title: "États & exports", body: "Préparez balances et états lisibles, avec un chemin clair entre source et résultat." },
      { title: "Travail en cabinet", body: "Passez d’un dossier à l’autre sans perdre les responsabilités, les remarques ni les validations." },
    ],
  },
  method: {
    kicker: "Notre méthode",
    title: "Trois temps. Une même exigence.",
    body: "La confiance ne se déclare pas dans une page marketing. Elle se construit dans la manière dont un dossier est traité.",
    steps: [
      { no: "01", title: "Rassembler", body: "Les écritures, pièces et informations utiles sont regroupées autour du dossier concerné." },
      { no: "02", title: "Éclairer", body: "Les éléments ambigus restent signalés. Les suggestions ne se déguisent pas en faits." },
      { no: "03", title: "Décider", body: "Une personne compétente contrôle, corrige et valide avant qu’un résultat ne serve." },
    ],
  },
  firms: {
    kicker: "Pour les cabinets",
    title: "Une vue nette sur le travail de chaque dossier.",
    body: "ARCOMPT accompagne les équipes qui doivent produire avec rigueur, expliquer leurs choix et garder la main sur plusieurs entreprises.",
    items: ["Accès et responsabilités pensés par dossier", "Passage de revue explicite", "Historique des actions et des contrôles", "Documents préparés pour être relus"],
    cta: "Découvrir l’espace cabinet",
  },
  guardrails: {
    kicker: "Ce que nous ne prétendons pas",
    title: "La précision commence par des limites dites clairement.",
    body: "Certaines fonctions dépendent de fournisseurs, de relectures pays ou d’un branchement qui n’est pas encore en place. Nous préférons une fonction coupée à un résultat inventé.",
    items: ["Pas de paiement mobile simulé", "Pas de certification fiscale annoncée sans connecteur réel", "Pas de déclaration présentée comme officielle sans pack pays publié", "Pas de validation automatique à la place d’un professionnel"],
  },
  close: {
    title: "Quand la comptabilité est bien tenue, les décisions respirent mieux.",
    body: "Découvrez ARCOMPT dans un environnement conçu pour les chiffres qui engagent une entreprise.",
    primary: "Accéder à ARCOMPT",
    secondary: "Écrire à l’équipe",
  },
  footer: { line: "Une comptabilité plus lisible pour l’espace OHADA.", legal: "Les déclarations officielles exigent un pack pays publié.", built: "ARCOMPT est une plateforme ARGILETTE." },
};

const en: LandingCopy = {
  nav: { product: "The platform", method: "Our method", forFirms: "For firms", signIn: "Sign in", contact: "Talk to the team", menu: "Menu", navigation: "Main navigation", home: "ARCOMPT home" },
  hero: {
    eyebrow: "OHADA accounting, with judgment",
    title: "Important numbers deserve more than a “confirm” button.",
    body: "ARCOMPT gives SMEs and accounting firms a clear workspace to keep, review and explain their accounts — within the SYSCOHADA framework.",
    primary: "Enter ARCOMPT",
    secondary: "See how we work",
    note: "A serious platform in progress. Not a promise of automatic compliance.",
  },
  proof: { label: "Built for work on the ground", items: ["SMEs across the OHADA region", "Accounting firms", "Multi-entity files", "Phone and desktop"] },
  principle: {
    kicker: "The founding principle",
    title: "Automate repetitive work. Keep judgment where it matters.",
    body: "A number extracted from a document is not yet an entry. A generated statement is not yet a decision. ARCOMPT makes it clear what is suggested, what is checked and what is approved by a person.",
    aside: "Technology prepares the file. A human gives it meaning.",
  },
  workspace: {
    kicker: "A workspace, not a black box",
    title: "Everything that deserves attention stays visible.",
    body: "A readable ledger, attached documents, pending operations and an audit trail that does not disappear into menus.",
    labels: { journal: "Operations journal", balance: "General ledger", pending: "Needs review", review: "Human review" },
  },
  modules: {
    kicker: "The daily core",
    title: "The right tools, in one place.",
    body: "Every module supports real accounting practice, without disguising what is not available yet.",
    items: [
      { title: "Entries & journals", body: "Organise entries by file, journal and period. Find the context behind the number." },
      { title: "Documents & matching", body: "Attach documents to operations and flag what needs a closer look." },
      { title: "Statements & exports", body: "Prepare readable balances and statements, with a clear path from source to result." },
      { title: "Firm workflow", body: "Move between files without losing ownership, comments or approvals." },
    ],
  },
  method: {
    kicker: "Our method",
    title: "Three moments. One standard.",
    body: "Trust is not declared on a marketing page. It is built into how a file is handled.",
    steps: [
      { no: "01", title: "Gather", body: "Entries, documents and useful context are brought together around the right file." },
      { no: "02", title: "Clarify", body: "Ambiguous items stay flagged. Suggestions never dress up as facts." },
      { no: "03", title: "Decide", body: "A qualified person checks, corrects and approves before a result is used." },
    ],
  },
  firms: {
    kicker: "For accounting firms",
    title: "A clear view of the work in every file.",
    body: "ARCOMPT supports teams that need to produce carefully, explain their choices and stay in control across several businesses.",
    items: ["Access and responsibility by file", "An explicit review step", "A history of actions and checks", "Documents prepared for review"],
    cta: "Explore the firm workspace",
  },
  guardrails: {
    kicker: "What we do not claim",
    title: "Precision starts with clear limits.",
    body: "Some functions depend on providers, country review or a connection that is not in place yet. We would rather switch a function off than invent a result.",
    items: ["No simulated mobile-money payments", "No tax certification claim without a real connector", "No filing presented as official without a published country pack", "No automatic approval in place of a professional"],
  },
  close: {
    title: "When the books are clear, decisions breathe easier.",
    body: "Explore ARCOMPT in a workspace designed for numbers that carry responsibility.",
    primary: "Access ARCOMPT",
    secondary: "Write to the team",
  },
  footer: { line: "Clearer accounting for the OHADA region.", legal: "Official filings require a published country pack.", built: "ARCOMPT is an ARGILETTE platform." },
};

export function getLandingCopy(locale: Locale): LandingCopy {
  return locale === "en" ? en : fr;
}