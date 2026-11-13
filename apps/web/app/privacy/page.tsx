import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Politique de confidentialité — ARCOMPT",
  description:
    "Comment ARCOMPT collecte, utilise et protège vos données personnelles et vos données de gestion.",
};

const sections: { title: string; body: string[] }[] = [
  {
    title: "1. Qui nous sommes",
    body: [
      "ARCOMPT est une plateforme de comptabilité en ligne éditée par ARGILETTE, destinée aux PME et aux cabinets d'expertise comptable de l'espace OHADA. Pour toute question relative à vos données, vous pouvez nous écrire à info@arcompt.com.",
    ],
  },
  {
    title: "2. Données que nous collectons",
    body: [
      "Informations de compte : nom, adresse e-mail et identifiants de connexion, gérés par notre prestataire d'authentification. Lorsque vous vous connectez avec Google, nous recevons votre nom, votre adresse e-mail et la photo de profil associée à votre compte Google.",
      "Données de gestion que vous saisissez dans la plateforme : clients, fournisseurs, devis, factures, écritures comptables, paie, documents et logos téléversés, ainsi que les informations de votre entreprise.",
      "Données techniques : journaux de connexion, adresse IP et type d'appareil, strictement nécessaires à la sécurité et au bon fonctionnement du service.",
    ],
  },
  {
    title: "3. Utilisation de vos données",
    body: [
      "Vos données servent uniquement à fournir le service ARCOMPT : authentification, tenue de votre comptabilité, génération de vos documents, assistance et sécurité. Nous ne vendons vos données à aucun tiers et ne les utilisons pas à des fins publicitaires.",
    ],
  },
  {
    title: "4. Prestataires",
    body: [
      "Nous faisons appel à des prestataires techniques pour l'hébergement de l'application et de la base de données, l'authentification des utilisateurs, l'envoi d'e-mails et le stockage de fichiers. Ces prestataires ne traitent vos données que pour notre compte et selon nos instructions.",
    ],
  },
  {
    title: "5. Conservation",
    body: [
      "Vos données sont conservées tant que votre compte est actif. Vous pouvez demander la suppression de votre compte et des données associées à tout moment en nous écrivant à info@arcompt.com ; certaines données peuvent être conservées lorsque la loi l'exige, notamment en matière comptable et fiscale.",
    ],
  },
  {
    title: "6. Vos droits",
    body: [
      "Vous disposez d'un droit d'accès, de rectification, d'export et de suppression de vos données personnelles. Pour exercer ces droits, écrivez-nous à info@arcompt.com ; nous répondons dans un délai raisonnable.",
    ],
  },
  {
    title: "7. Cookies",
    body: [
      "ARCOMPT utilise uniquement les cookies nécessaires à l'authentification et au fonctionnement de la plateforme. Nous n'utilisons aucun cookie publicitaire ni outil de suivi marketing.",
    ],
  },
  {
    title: "8. Sécurité",
    body: [
      "Les échanges avec la plateforme sont chiffrés en transit. L'accès aux données est restreint par des contrôles d'accès par entreprise et par utilisateur, et les opérations sensibles sont journalisées.",
    ],
  },
  {
    title: "9. Modifications",
    body: [
      "Cette politique peut évoluer. La date de dernière mise à jour indiquée en haut de cette page fait foi, et toute modification importante sera portée à la connaissance des utilisateurs sur la plateforme.",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[#F7F5F0] text-slate-900">
      <div className="mx-auto w-full max-w-3xl px-6 py-12">
        <Link href="/" className="text-sm font-medium text-slate-600 underline-offset-4 hover:underline">
          ← Retour à l’accueil
        </Link>
        <h1 className="mt-8 text-3xl font-semibold tracking-tight">Politique de confidentialité</h1>
        <p className="mt-2 text-sm text-slate-500">Dernière mise à jour : 13 octobre 2026</p>
        <div className="mt-10 space-y-10">
          {sections.map((s) => (
            <section key={s.title}>
              <h2 className="text-lg font-semibold">{s.title}</h2>
              {s.body.map((p, i) => (
                <p key={i} className="mt-3 leading-relaxed text-slate-700">
                  {p}
                </p>
              ))}
            </section>
          ))}
        </div>
        <footer className="mt-14 border-t border-[#E6E1D5] pt-6 text-sm text-slate-500">
          ARCOMPT · un service ARGILETTE. Contact :{" "}
          <a href="mailto:info@arcompt.com" className="underline-offset-4 hover:underline">
            info@arcompt.com
          </a>
        </footer>
      </div>
    </main>
  );
}
