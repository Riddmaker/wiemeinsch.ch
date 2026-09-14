import { Link } from "@/i18n/navigation";

/**
 * @handle als Link aufs öffentliche Profil (P11.5, DRY): benutzt überall dort,
 * wo eine Meta-Zeile eine Autorin oder einen Autor nennt (Ticket, Statement,
 * Änderungsantrag). Ohne Handle wird nichts gerendert — es gibt dann kein
 * öffentliches Profil, auf das verlinkt werden könnte.
 */
export function AuthorLink({
  userId,
  handle,
  className,
}: {
  userId: string;
  handle: string | null;
  className?: string;
}) {
  if (!handle) {
    return null;
  }
  return (
    <Link
      href={`/profil/${userId}`}
      data-testid="author-link"
      className={className ?? "underline underline-offset-2 hover:text-ink"}
    >
      @{handle}
    </Link>
  );
}
