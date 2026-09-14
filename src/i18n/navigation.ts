import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

// Locale-bewusste Navigations-Primitiven — in der App IMMER diese verwenden,
// nie next/link oder next/navigation direkt (Sprachwechsel bleibt sonst nicht
// auf der aktuellen Seite).
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
