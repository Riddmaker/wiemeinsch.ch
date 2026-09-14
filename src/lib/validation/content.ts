import { z } from "./zod";
import {
  FUNDING_MAX,
  HASHTAG_MAX_COUNT,
  HASHTAG_MAX_LENGTH,
  PROBLEM_MAX,
  PROBLEM_MIN,
  SOLUTION_MAX,
  SOLUTION_MIN,
  STATEMENT_MAX,
  STATEMENT_MIN,
  TITLE_MAX,
} from "./limits";
import {
  constrainedDocSchema,
  graphemeLength,
  plainTextLength,
} from "./tiptap";

/**
 * Geteilte Content-Schemas (Statements).
 * Werden von Client-Formularen UND Server Actions importiert (
 * → Import-Richtung, lib/validation als Single Source of Truth).
 */

function richTextSchema(min: number, max: number) {
  return constrainedDocSchema
    .refine((doc) => plainTextLength(doc) >= min, { message: `min_${min}` })
    .refine((doc) => plainTextLength(doc) <= max, { message: `max_${max}` });
}

export const titleSchema = z
  .string()
  .trim()
  .min(1, { message: "min_1" })
  .refine((value) => graphemeLength(value) <= TITLE_MAX, {
    message: `max_${TITLE_MAX}`,
  });

export const problemSchema = richTextSchema(PROBLEM_MIN, PROBLEM_MAX);
export const solutionSchema = richTextSchema(SOLUTION_MIN, SOLUTION_MAX);
// Finanzierung ist optional; wenn vorhanden, gilt nur das Maximum.
export const fundingSchema = richTextSchema(0, FUNDING_MAX).optional();
export const statementContentSchema = richTextSchema(
  STATEMENT_MIN,
  STATEMENT_MAX,
);

/**
 * Hashtag-Normalisierung : lowercase, ohne führendes "#".
 * Erlaubt: Buchstaben (inkl. Umlaute), Ziffern, "_" und "-" — keine Leerzeichen.
 */
export const hashtagSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^#/, "").toLowerCase())
  .refine((value) => value.length > 0, { message: "min_1" })
  .refine((value) => graphemeLength(value) <= HASHTAG_MAX_LENGTH, {
    message: `max_${HASHTAG_MAX_LENGTH}`,
  })
  .refine((value) => /^[\p{L}\p{N}_-]+$/u.test(value), {
    message: "invalid_chars",
  });

export const hashtagsSchema = z
  .array(hashtagSchema)
  .max(HASHTAG_MAX_COUNT, { message: `max_${HASHTAG_MAX_COUNT}` })
  .refine((tags) => new Set(tags).size === tags.length, {
    message: "duplicates",
  });
