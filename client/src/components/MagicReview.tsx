import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  POP_W,
  barCopy,
  keptNotes,
  popPlace,
  type ReviewNote,
} from "@/lib/magic-feedback";

// Magic feedback's review screen, ported from the Rico cockpit's MagicReview:
// numbered pins only, 1..N in the order they were spoken. Hovering a pin opens
// its note; clicking holds it open with the words in a field to change, and
// Remove drops a note never meant. One note open at a time, so nothing
// overlaps. What is left is exactly what is filed, under the same numbers
// burned into the screenshot.
export default function MagicReview({
  initialNotes,
  questions,
  onDiscard,
  onSend,
}: {
  initialNotes: ReviewNote[];
  questions: string[];
  onDiscard: () => void;
  onSend: (notes: ReviewNote[]) => void;
}) {
  const [notes, setNotes] = useState(initialNotes);
  const [hover, setHover] = useState(-1);
  const [open, setOpen] = useState(-1);
  const shown = open >= 0 ? open : hover;
  const kept = keptNotes(notes);
  const copy = barCopy(kept.length);
  const qs = (questions || []).filter(Boolean);
  const viewport = { width: window.innerWidth, height: window.innerHeight };

  const unhover = (i: number) => setHover(h => (h === i ? -1 : h));
  const edit = (i: number, text: string) =>
    setNotes(ns => ns.map((n, k) => (k === i ? { ...n, text } : n)));
  const remove = (i: number) => {
    setNotes(ns => ns.filter((_, k) => k !== i));
    setOpen(-1);
    setHover(-1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(-1);
      setHover(-1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const n = shown >= 0 ? notes[shown] : undefined;
  const editing = n !== undefined && open === shown;

  return (
    <div data-mf-ui="">
      {notes.map((note, i) => (
        <Button
          key={i}
          type="button"
          size="icon-sm"
          variant={shown === i ? "default" : "secondary"}
          aria-label={"Note " + (i + 1)}
          className="fixed z-[2147483000] size-6 -translate-x-1/2 -translate-y-1/2 rounded-full text-xs font-bold shadow-md ring-2 ring-background"
          style={{ left: note.x, top: note.y }}
          onMouseEnter={() => setHover(i)}
          onMouseLeave={() => unhover(i)}
          onFocus={() => setHover(i)}
          onClick={() => setOpen(o => (o === i ? -1 : i))}
        >
          {i + 1}
        </Button>
      ))}

      {n && (
        <Card
          role="dialog"
          aria-label={"Note " + (shown + 1)}
          className="fixed z-[2147483001] gap-2 px-3.5 py-3 text-sm shadow-lg"
          style={{ width: POP_W, ...popPlace(n, viewport) }}
          onMouseEnter={() => setHover(shown)}
          onMouseLeave={() => unhover(shown)}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10.5px] font-bold text-primary-foreground">
              {shown + 1}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {n.label}
            </span>
          </div>
          {editing ? (
            <>
              <Textarea
                value={n.text}
                rows={3}
                autoFocus
                aria-label={"Note " + (shown + 1) + " text"}
                onFocus={e =>
                  e.currentTarget.setSelectionRange(
                    e.currentTarget.value.length,
                    e.currentTarget.value.length
                  )
                }
                onChange={e => edit(shown, e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => remove(shown)}
                >
                  Remove
                </Button>
                <Button size="sm" onClick={() => setOpen(-1)}>
                  Done
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="m-0 text-card-foreground">{n.text}</p>
              <p className="m-0 text-xs text-muted-foreground">
                Click the number to edit or remove
              </p>
            </>
          )}
        </Card>
      )}

      <Card className="fixed bottom-6 left-1/2 z-[2147483001] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-row items-center gap-2.5 py-2.5 pl-4 pr-3 text-sm shadow-lg">
        <div className="min-w-0 flex-1 text-muted-foreground">
          <strong className="font-semibold text-foreground">
            {copy.count}
          </strong>
          <span className="hidden sm:inline">{copy.hint}</span>
          {qs.length > 0 && (
            <span
              className="block max-w-[340px] truncate"
              title={qs.join(" · ")}
            >
              {qs.join(" · ")}
            </span>
          )}
        </div>
        <Button variant="outline" onClick={onDiscard}>
          Discard
        </Button>
        <Button onClick={() => onSend(notes)}>Send to Rico</Button>
      </Card>
    </div>
  );
}
