import type { ReactNode } from "react";
import { Avatar } from "@/components/profile/Avatar";
import { Link } from "@/i18n/navigation";

/**
 * @handle als Link aufs öffentliche Profil (P11.5, DRY): benutzt überall dort,
 * wo eine Meta-Zeile eine Autorin oder einen Autor nennt (Ticket, Statement,
 * Änderungsantrag). Ohne Handle wird nichts gerendert — es gibt dann kein
 * öffentliches Profil, auf das verlinkt werden könnte. Seit 27.09.2026 mit
 * dem Profilbild davor; `children` ersetzt den reinen @handle, wo die
 * Meta-Zeile einen Satz braucht («von @x»).
 */
export function AuthorLink({
  userId,
  handle,
  avatarSeed,
  className,
  testId = "author-link",
  children,
}: {
  userId: string;
  handle: string | null;
  avatarSeed: string;
  className?: string;
  testId?: string;
  children?: ReactNode;
}) {
  if (!handle) {
    return null;
  }
  return (
    <Link
      href={`/profil/${userId}`}
      data-testid={testId}
      className={`inline-flex items-center gap-1.5 align-middle ${className ?? "underline underline-offset-2 hover:text-ink"}`}
    >
      <Avatar seed={avatarSeed} className="h-4 w-4" />
      <span>{children ?? `@${handle}`}</span>
    </Link>
  );
}
