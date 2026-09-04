"use client";

import { useTransition } from "react";
import { markNotificationsRead } from "@/actions/profile";
import { useRouter } from "@/i18n/navigation";

/**
 * «Alles als gelesen markieren» (E14). Setzt serverseitig einen einzigen
 * Zeitstempel; danach verschwinden Panel und roter Punkt, bis wieder etwas
 * passiert. Der Text kommt von aussen, damit die Übersetzung serverseitig
 * geladen wird wie im übrigen Profil.
 */
export function MarkNotificationsReadButton({ label }: { label: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      data-testid="notifications-mark-read"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          await markNotificationsRead();
          router.refresh();
        });
      }}
      className="rounded-[2px] border-[1.5px] border-ink bg-paper px-3 py-1.5 font-mono text-[12px] font-bold uppercase tracking-wide text-ink hover:bg-surface disabled:cursor-not-allowed disabled:border-line disabled:text-meta"
    >
      {label}
    </button>
  );
}
