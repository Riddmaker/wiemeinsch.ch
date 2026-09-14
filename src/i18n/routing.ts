import { defineRouting } from "next-intl/routing";

// Locale-Routing /de /fr /it.
export const routing = defineRouting({
  locales: ["de", "fr", "it"],
  defaultLocale: "de",
});

export type AppLocale = (typeof routing.locales)[number];
