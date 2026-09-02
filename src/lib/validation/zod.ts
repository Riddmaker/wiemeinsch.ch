import { z } from "zod";

/**
 * Einziger erlaubter Zod-Einstiegspunkt (P13.2).
 *
 * Zod 4 kompiliert Validatoren per `new Function` und stellt vorher fest, ob
 * die Umgebung das erlaubt. Unter unserer strikten CSP (`script-src` ohne
 * `'unsafe-eval'`) schlägt dieser Versuch fehl; Zod fängt den Fehler ab und
 * fällt korrekt zurück — der Browser meldet die geblockte Ausführung aber
 * trotzdem als `securitypolicyviolation`. In Produktion war das eine
 * Violation pro Seite mit clientseitigem Schema (empirisch in P13 gemessen).
 *
 * `jitless: true` überspringt den Versuch von vornherein (so dokumentiert es
 * die Zod-Quelle in `v4/core/util.cjs`: «Skip the probe under `jitless`»).
 * Der Preis ist der langsamere Nicht-JIT-Pfad — bei Objekten dieser Grösse
 * ohne messbare Wirkung, und eine dauerhaft rauschende CSP-Konsole wäre
 * teurer: Sie macht echte Violations unsichtbar.
 *
 * Die Konfiguration ist pro JS-Realm global. Weil Server und Browser
 * getrennte Realms sind, muss sie in BEIDEN Bundles landen — deshalb geht
 * jeder Schema-Import über dieses Modul statt direkt über "zod".
 */
z.config({ jitless: true });

export { z };
