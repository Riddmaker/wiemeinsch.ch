import { describe, expect, it } from "vitest";

/**
 * Board-Pagination (04.09.2026): Der `seiten`-Parameter kommt aus der URL und
 * ist damit ungeprüfte Nutzereingabe. Er darf weder einen Fehler auslösen noch
 * beliebig grosse Abfragen erzeugen (OWASP A04, Ressourcenerschöpfung).
 */
import {
  boardFetchSize,
  BOARD_MAX_PAGES,
  BOARD_PAGE_SIZE,
  parseBoardPages,
} from "@/lib/board-paging";

describe("parseBoardPages", () => {
  it("liefert ohne Parameter die erste Seite", () => {
    expect(parseBoardPages(undefined)).toBe(1);
  });

  it("liest gültige Ziffernfolgen", () => {
    expect(parseBoardPages("1")).toBe(1);
    expect(parseBoardPages("3")).toBe(3);
  });

  it.each([
    ["Text", "abc"],
    ["leer", ""],
    ["Null", "0"],
    ["negativ", "-2"],
    ["Vorzeichen", "+2"],
    ["Komma", "2.5"],
    ["Leerzeichen", " 2 "],
    ["Hex", "0x10"],
    ["Exponent", "1e3"],
    ["Unendlich", "Infinity"],
  ])("fällt bei ungültigem Wert (%s) auf Seite 1 zurück", (_label, raw) => {
    expect(parseBoardPages(raw)).toBe(1);
  });

  it("ignoriert einen mehrfach gesetzten Parameter (Array)", () => {
    expect(parseBoardPages(["2", "9"])).toBe(1);
  });

  it("deckelt zu grosse Werte statt sie durchzureichen", () => {
    expect(parseBoardPages("999999")).toBe(BOARD_MAX_PAGES);
    expect(parseBoardPages(String(BOARD_MAX_PAGES + 1))).toBe(BOARD_MAX_PAGES);
    expect(parseBoardPages(String(BOARD_MAX_PAGES))).toBe(BOARD_MAX_PAGES);
  });

  it("bleibt auch bei absurd langen Ziffernfolgen im Rahmen", () => {
    expect(parseBoardPages("9".repeat(400))).toBe(BOARD_MAX_PAGES);
  });
});

describe("boardFetchSize", () => {
  it("holt genau eine Zeile mehr als angezeigt wird", () => {
    expect(boardFetchSize(1)).toBe(BOARD_PAGE_SIZE + 1);
    expect(boardFetchSize(3)).toBe(3 * BOARD_PAGE_SIZE + 1);
  });

  it("bleibt auch am Deckel endlich", () => {
    expect(boardFetchSize(BOARD_MAX_PAGES)).toBe(
      BOARD_MAX_PAGES * BOARD_PAGE_SIZE + 1,
    );
  });
});
