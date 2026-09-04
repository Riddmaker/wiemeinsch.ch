# wiemeinsch.ch

Das „Civic-Jira" für die Schweiz: eine Plattform, auf der Bürgerinnen und Bürger
politische Probleme als Tickets einreichen und gemeinsam an Lösungen arbeiten.
Sie belohnt Konsens und bestraft Ragebait — statt einer Kommentarspalte gibt es
**Political Pull Requests** für konstruktive Gegenvorschläge, und ein
KI-gestützter **Civic-Linter** blockiert Polemik, bevor sie publiziert wird.

Mehrsprachig in Deutsch, Französisch und Italienisch: Jeder Beitrag wird beim
Publizieren in alle drei Landessprachen übersetzt, die Originalsprache bleibt
ausgewiesen.

> Das Projekt ist in Entwicklung und noch nicht öffentlich erreichbar.

---

## Inhalt

- [Kernideen](#kernideen)
- [Technischer Überblick](#technischer-überblick)
- [Lokale Entwicklung](#lokale-entwicklung)
- [Tests](#tests)
- [Sicherheit](#sicherheit)
- [Lizenz](#lizenz)

---

## Kernideen

| Mechanismus | Was er bewirkt |
|---|---|
| **Civic-Linter** | Zweistufige KI-Prüfung vor dem Publizieren: erst ein Moderations-Modell gegen Toxizität und Prompt-Injection, dann ein Sprachmodell gegen Polemik und Unsachlichkeit. Wer blockiert wird, sieht die beanstandete Stelle, bekommt — wenn ein sachlicher Kern erkennbar ist — einen Formulierungsvorschlag, und kann den Entscheid anfechten. |
| **Political Pull Request** | Wer ein fremdes Ticket verbessern will, stellt einen Änderungsantrag auf Titel, Problem, Lösung, Finanzierung oder Hashtags. Nur die Autorschaft entscheidet über den Merge; wird gemergt, wird die antragstellende Person Co-Autor. |
| **Statement-Dashboard** | Beiträge sind kategorisiert (Pro, Contra, Erweiterung, Frage) — und es gibt **keine Antwortfunktion**. Ohne Threads entsteht kein Schlagabtausch. |
| **Drei Ranglisten** | *Konsens* (Wilson-Untergrenze — breite Zustimmung schlägt laute Nische), *Kontrovers* (macht Spaltung sichtbar, statt sie zu belohnen) und *Trending* (Aktivität mit Zeitverfall). |
| **Pseudonymität** | Der öffentliche `@handle` entsteht zufällig aus schweizerischen Orts- und Gewässernamen und hat keinen Bezug zur Mailadresse. Er steht über jedem Beitrag — ein aus der Adresse abgeleiteter Name hätte Klarnamen dauerhaft veröffentlicht. |
| **Datensparsamkeit** | Demografische Angaben sind freiwillig und verlassen den Server nie pro Person. Ein dauerhafter Test schlägt fehl, sobald eine dieser Spalten irgendwo ausserhalb der erlaubten Stellen auftaucht. |

## Technischer Überblick

- **Next.js 16** (App Router, Turbopack, React 19, TypeScript strict)
- **PostgreSQL 18** über **Prisma 7** mit `@prisma/adapter-pg`
- **next-intl** für DE/FR/IT, **NextAuth v4** (Magic Link + Google OAuth)
- **Mistral AI** für Civic-Linter und Übersetzung
- **TipTap** als eingeschränkter Editor (nur fett, kursiv, Aufzählung)
- **Tailwind 4** nach einem eigenen Styleguide im Stil des Swiss Design
- Container: Multi-Stage-`Dockerfile`, Non-Root-Runtime, Healthcheck `/api/health`

Architekturprinzipien, die im Code durchgesetzt werden:

- **Server Actions sind der einzige Mutationsweg.** Client-Komponenten
  importieren nie direkt aus `src/services/` oder `src/lib/prisma.ts`.
- **Zeichenlimiten und LLM-Antwortformate leben in `src/lib/validation/`** und
  werden von Formular und Server Action gemeinsam importiert — keine doppelt
  gepflegten Grenzen.
- **UI-Texte stehen ausschliesslich in `messages/`** (de/fr/it), nie im Code.
- **Rate-Limiting** in PostgreSQL, zweischichtig (pro Konto und pro IP), mit
  einem gemeinsamen Budget über alle KI-Endpunkte.
- **CSP mit Nonce und `strict-dynamic`**, Ausgabe von LLM-Inhalten
  ausschliesslich als Text.

## Lokale Entwicklung

Voraussetzungen: Node.js ≥ 24, npm ≥ 11, Docker Desktop.

```bash
npm ci                  # exakte Versionen aus package-lock.json
cp .env.example .env    # lokale Werte eintragen — .env wird nie committet
docker compose up -d    # App (Hot Reload), PostgreSQL, Mailpit
npx prisma migrate deploy
npx prisma db seed      # Stammdaten + Testdaten
```

Die App läuft auf `http://localhost:3000`, der Mail-Fänger **Mailpit** auf
`http://localhost:8025` (dort landen die Magic-Link-Mails).

Die Datenbank veröffentlicht **bewusst keinen Host-Port** — Zugriff nur aus dem
Compose-Netz (`docker compose exec db psql …`).

**Zwei Compose-Modi:**

```bash
docker compose up                          # Dev: next dev mit Hot Reload
docker compose --profile prod up --build   # Prod: exakt das Image der Pipeline
```

Abgenommen wird gegen das **Prod-Profil**, nicht gegen `next dev`.

Qualitätsschranken — alle müssen grün sein:

```bash
npm run lint            # ESLint
npm run typecheck       # tsc --noEmit
npm run format:check    # Prettier
npm run test            # Vitest (tests/unit)
npm run test:e2e        # Playwright (tests/e2e), braucht die Compose-Umgebung
npm run scan:secrets    # Pre-Push-Scan auf Anmeldedaten im Arbeitsbaum
```

## Tests

- **Unit** (`tests/unit/`): Services, Scoring-Formeln, Zod-Schemas, die
  vollständige Access-Control-Matrix, Katalog-Gleichheit DE/FR/IT. Der Zugang
  zur KI ist in der Testumgebung gesperrt — jeder ungemockte Aufruf scheitert
  sofort, statt still Budget zu verbrauchen.
- **E2E** (`tests/e2e/`): Playwright gegen die lokale Compose-Instanz, inklusive
  Barrierefreiheits-Abnahme mit axe-core (WCAG 2.1 A/AA, Schwelle 0 Verstösse
  der Stufen *critical*/*serious*) und einer Sicht-Abnahme über
  Sprache × Kernseite × {375, 1280} px.
- **`@ai`-Markierung:** Tests, die echte Mistral-Aufrufe auslösen, tragen dieses
  Tag. Die Pipeline fährt `--grep-invert "@ai"` — sie kosten API-Budget und
  würden jeden Merge von einer externen API abhängig machen. Lokal läuft die
  Suite vollständig, und genau das ist die Abnahme vor dem Push.
- **Login-Budget:** Magic Links sind auf 5 pro Adresse und 15 Minuten begrenzt.
  Ein Suite-Lauf bleibt darunter; zwei volle Läufe in einer Viertelstunde nicht
  — das ist die Bremse, die funktioniert, kein Testfehler.

## Sicherheit

Die Anwendung richtet sich nach den [OWASP Top 10](https://owasp.org/Top10/) und
den OWASP-Empfehlungen für generative KI. Umgesetzt sind unter anderem:

- Prompt-Injection-Abwehr im Civic-Linter: Nutzertext ist im Prompt ein
  abgegrenzter Datenblock, nie Instruktion; Jailbreak-Versuche werden blockiert,
  ohne den Text an ein Chat-Modell weiterzureichen.
- LLM-Antworten werden schema-validiert und ausschliesslich als Text gerendert,
  nie als Markup.
- Zweischichtiges Rate-Limiting, Turnstile vor dem Login, CSP mit Nonce.
- Serverseitige Berechtigungsprüfung in jeder Server Action, abgesichert durch
  eine vollständige Access-Control-Testmatrix.

**Schwachstellen bitte nicht als öffentliches Issue melden**, sondern über die
im Impressum der Website genannte Kontaktadresse — mit Beschreibung, Weg zur
Reproduktion und, wenn möglich, einer Einschätzung der Auswirkung.

Der Betrieb der Zielumgebung (Topologie, Secrets, Backup und Wiederherstellung)
ist bewusst nicht Teil dieses Repositories.

---

## Lizenz

[PolyForm Noncommercial License 1.0.0](LICENSE.md) — frei für Bürgerinnen und
Bürger, NGOs, Bildungs- und Regierungsinstitutionen. Kommerzielle Nutzung
erfordert eine separate Lizenz des Rechteinhabers.

Required Notice: Copyright Cedric Meier (https://wiemeinsch.ch)
