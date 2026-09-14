"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

/**
 * «Nach oben» für lange Listen (04.09.2026).
 *
 * Bewusst kein schwebender Footer: Der würde auf jedem Bildschirm dauerhaft
 * Platz kosten und widerspräche der ruhigen Kopf-/Fusszeile des Styleguides.
 * Dieser Knopf erscheint erst, wenn wirklich gescrollt wurde, und
 * verschwindet danach wieder.
 */

/** Erst ab dieser Scrolltiefe einblenden (ca. eine Bildschirmhöhe). */
const SHOW_AFTER_PX = 800;

export function BackToTop() {
  const t = useTranslations("common");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > SHOW_AFTER_PX);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const toTop = () => {
    // Sanftes Scrollen nur, wenn der Nutzer keine reduzierte Bewegung wünscht.
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  };

  return (
    <button
      type="button"
      onClick={toTop}
      data-testid="back-to-top"
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      className={`fixed bottom-5 right-5 z-40 border-[1.5px] border-ink bg-paper px-3 py-2 font-mono text-[13px] font-bold uppercase tracking-wide text-ink shadow-[3px_3px_0_0_var(--color-ink)] transition-opacity hover:bg-ink hover:text-paper ${
        visible ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <span aria-hidden="true">↑</span>
      <span className="sr-only">{t("backToTop")}</span>
    </button>
  );
}
