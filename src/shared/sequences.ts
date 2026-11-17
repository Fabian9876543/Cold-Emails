import type { CampaignStepDto, Formality } from "./types";

// Startvorlagen für Sequenzen. Lückentexte in [eckigen Klammern] müssen vor dem Start ausgefüllt werden.

export interface SequenceTemplate {
  id: string;
  name: string;
  description: string;
  steps: Record<Formality, CampaignStepDto[]>;
}

export const SEQUENCE_TEMPLATES: SequenceTemplate[] = [
  {
    id: "termin",
    name: "Gesprächstermin anfragen",
    description: "Klassischer Erstkontakt mit einer konkreten, leicht zu beantwortenden Frage und zwei kurzen Nachfass-Mails.",
    steps: {
      sie: [
        {
          position: 1,
          waitDays: 0,
          subject: "Frage zu {{firma}}",
          body: "{{begruessung}},\n\n{{ki_einstieg|bei meiner Recherche bin ich auf Ihr Unternehmen gestoßen.}}\n\nWir unterstützen [Zielgruppe, z. B. Logistikunternehmen] dabei, [konkretes Ergebnis, z. B. Leerfahrten um 20 % zu senken] – zum Beispiel [kurzer Beleg oder Referenzkunde].\n\nWäre ein kurzes Gespräch von 15 Minuten in den nächsten Tagen für Sie interessant?\n\nViele Grüße",
        },
        {
          position: 2,
          waitDays: 3,
          subject: "",
          body: "{{begruessung}},\n\nich hole meine letzte Nachricht noch einmal kurz nach oben – passt das Thema gerade zu {{firma|Ihrem Unternehmen}}?\n\nEine kurze Antwort genügt, auch wenn es ein „Nein“ ist.\n\nViele Grüße",
        },
        {
          position: 3,
          waitDays: 5,
          subject: "",
          body: "{{begruessung}},\n\nich möchte Sie nicht weiter stören und melde mich deshalb ein letztes Mal. Falls [Thema] später interessant wird, antworten Sie einfach auf diese E-Mail.\n\nViele Grüße",
        },
      ],
      du: [
        {
          position: 1,
          waitDays: 0,
          subject: "Frage zu {{firma}}",
          body: "{{begruessung}},\n\n{{ki_einstieg|bei meiner Recherche bin ich auf euer Unternehmen gestoßen.}}\n\nWir helfen [Zielgruppe, z. B. Agenturen] dabei, [konkretes Ergebnis] – zum Beispiel [kurzer Beleg oder Referenzkunde].\n\nHättest du in den nächsten Tagen 15 Minuten für einen kurzen Austausch?\n\nViele Grüße",
        },
        {
          position: 2,
          waitDays: 3,
          subject: "",
          body: "{{begruessung}},\n\nich hole meine letzte Nachricht kurz nach oben – passt das Thema gerade zu {{firma|euch}}?\n\nEine kurze Antwort genügt, auch wenn es ein „Nein“ ist.\n\nViele Grüße",
        },
        {
          position: 3,
          waitDays: 5,
          subject: "",
          body: "{{begruessung}},\n\nich will dich nicht weiter stören und melde mich ein letztes Mal. Falls [Thema] später spannend wird, antworte einfach auf diese Mail.\n\nViele Grüße",
        },
      ],
    },
  },
  {
    id: "frage",
    name: "Kurze Frage (sehr knapp)",
    description: "Sehr kurze Mail, die nur eine Frage stellt – ideal, um überhaupt ins Gespräch zu kommen.",
    steps: {
      sie: [
        {
          position: 1,
          waitDays: 0,
          subject: "Kurze Frage",
          body: "{{begruessung}},\n\n{{ki_einstieg|ich habe eine kurze Frage an Sie.}}\n\nWer ist bei {{firma|Ihnen}} für [Thema, z. B. den Einkauf von Verpackungsmaterial] zuständig?\n\nVielen Dank vorab!",
        },
        {
          position: 2,
          waitDays: 4,
          subject: "",
          body: "{{begruessung}},\n\nfalls meine Frage untergegangen ist: Können Sie mir sagen, wer bei Ihnen [Thema] verantwortet?\n\nViele Grüße",
        },
      ],
      du: [
        {
          position: 1,
          waitDays: 0,
          subject: "Kurze Frage",
          body: "{{begruessung}},\n\n{{ki_einstieg|ich habe eine kurze Frage an dich.}}\n\nWer ist bei {{firma|euch}} für [Thema] zuständig?\n\nDanke dir!",
        },
        {
          position: 2,
          waitDays: 4,
          subject: "",
          body: "{{begruessung}},\n\nfalls meine Frage untergegangen ist: Weißt du, wer bei euch [Thema] verantwortet?\n\nViele Grüße",
        },
      ],
    },
  },
  {
    id: "leer",
    name: "Leere Vorlage",
    description: "Sie schreiben alles selbst – oder lassen die KI-Schreibhilfe einen Entwurf erstellen.",
    steps: {
      sie: [{ position: 1, waitDays: 0, subject: "", body: "{{begruessung}},\n\n\n\nViele Grüße" }],
      du: [{ position: 1, waitDays: 0, subject: "", body: "{{begruessung}},\n\n\n\nViele Grüße" }],
    },
  },
];
