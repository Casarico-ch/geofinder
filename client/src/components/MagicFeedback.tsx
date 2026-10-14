import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import MagicReview from "@/components/MagicReview";
import { RESUMED_LINE, formatClock } from "@/lib/magic-feedback";
import { MagicFeedbackWidget } from "@/lib/magic-feedback-widget";
import { cn } from "@/lib/utils";

// Magic feedback for everyone on GeoFinder (Daniel, 03.10: "everyone on
// GeoFinder can submit a magic feedback"). Alt+Shift+M (Mac: ⌥⇧M) starts and
// stops a recording; the review screen follows. Mounted once, at App level, so
// in-app navigation never unmounts it: one recording follows you across pages,
// and a real page load picks it up again from where it was saved.
export default function MagicFeedback() {
  const [widget] = useState(
    () =>
      new MagicFeedbackWidget((kind, message) => {
        if (kind === "success") toast.success(message);
        else toast.error(message);
      })
  );
  useEffect(() => widget.attach(), [widget]);
  const state = useSyncExternalStore(widget.subscribe, widget.getState);
  const keepNotes = useCallback(
    (notes: Parameters<typeof widget.setNotes>[0]) => widget.setNotes(notes),
    [widget]
  );

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.phase !== "recording") return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [state.phase]);

  if (state.phase === "recording" || state.phase === "reading") {
    const reading = state.phase === "reading";
    const resumedLine = !reading && state.resumed;
    return (
      <Card
        data-mf-ui=""
        role="status"
        className={cn(
          "fixed bottom-5 right-5 z-[2147483000] gap-1 px-4 py-2.5 text-sm font-medium shadow-lg",
          resumedLine ? "max-w-80 rounded-2xl" : "rounded-full"
        )}
      >
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              "size-2 rounded-full",
              reading ? "bg-muted-foreground" : "animate-pulse bg-destructive"
            )}
          />
          <span>{reading ? "Reading that back…" : "Listening…"}</span>
          {!reading && (
            <span className="tabular-nums text-muted-foreground">
              {formatClock(now - state.startedAt)}
            </span>
          )}
        </div>
        {resumedLine && (
          <p className="m-0 text-xs font-normal text-muted-foreground">
            {RESUMED_LINE}
          </p>
        )}
      </Card>
    );
  }

  if (state.phase === "review" && state.reply) {
    return (
      <MagicReview
        initialNotes={state.notes}
        pages={state.pages}
        onChange={keepNotes}
        questions={state.reply.questions}
        onDiscard={() => widget.discard()}
        onSend={notes => void widget.send(notes)}
      />
    );
  }
  return null;
}
