import { notFound } from "next/navigation";
import { EditorPlayground } from "@/components/dev/EditorPlayground";

// Dev-only-Testseite für den Constrained Editor (T5) — in Prod nicht vorhanden.
export default function DevEditorPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return <EditorPlayground />;
}
