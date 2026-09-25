/**
 * Minimale Typen für den einzigen direkten nodemailer-Aufruf
 * (`src/lib/magic-link-mail.ts`). nodemailer 9 bringt keine eigenen
 * Deklarationen mit, und `@types/nodemailer` folgt einer älteren Major —
 * statt einer zweiten Abhängigkeit, die der Laufzeit-Version hinterherhinkt,
 * steht hier genau die Fläche, die der Code benutzt.
 */
declare module "nodemailer" {
  export type SendMailOptions = {
    to: string;
    from?: string;
    subject: string;
    text: string;
    html: string;
  };

  export type SentMessageInfo = {
    accepted: unknown[];
    rejected: unknown[];
    pending?: unknown[];
  };

  export type Transporter = {
    sendMail(options: SendMailOptions): Promise<SentMessageInfo>;
  };

  export function createTransport(options: unknown): Transporter;
}
