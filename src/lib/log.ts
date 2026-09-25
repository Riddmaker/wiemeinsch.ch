/**
 * Server-Log (Code-Review 25.09.2026).
 *
 * Befund: `src/` enthielt kein einziges Log. Jede Action fing
 * `MistralUnavailableError` ab und gab nur `ai_unavailable` zurück — ein
 * abgelaufener Schlüssel, ein erschöpftes Budget oder ein abgekündigtes
 * Modell legten jedes Einreichen still, und im Log stand nichts.
 *
 * Eine Zeile JSON pro Ereignis auf stdout/stderr (Jelastic sammelt beides).
 * Bewusst NIE Nutzertext, E-Mail-Adressen, Tokens oder Fehlermeldungen
 * externer Dienste: Die können Teile der Anfrage zurückspiegeln. Geloggt
 * werden nur Ereignisname, Fehlerklasse, HTTP-Status und ähnliche Metadaten.
 */

export type LogLevel = "info" | "warn" | "error";

export type LogFields = Record<string, string | number | boolean | null>;

export function logEvent(
  level: LogLevel,
  event: string,
  fields: LogFields = {},
): void {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Nur die Klasse und, falls vorhanden, der HTTP-Status eines Fehlers — nie
 * seine Meldung (siehe Kopfkommentar).
 */
export function errorFields(error: unknown): LogFields {
  if (!(error instanceof Error)) {
    return { errorType: typeof error };
  }
  const fields: LogFields = { errorName: error.name };
  const status = httpStatusOf(error);
  if (status !== null) {
    fields.httpStatus = status;
  }
  const cause: unknown = error.cause;
  if (cause instanceof Error) {
    fields.causeName = cause.name;
    const causeStatus = httpStatusOf(cause);
    if (causeStatus !== null) {
      fields.causeHttpStatus = causeStatus;
    }
  }
  return fields;
}

function httpStatusOf(error: Error): number | null {
  const status: unknown = (error as Error & { statusCode?: unknown })
    .statusCode;
  return typeof status === "number" ? status : null;
}
