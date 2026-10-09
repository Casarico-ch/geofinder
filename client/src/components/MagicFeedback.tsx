import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import MagicReview from "@/components/MagicReview";
import { formatClock } from "@/lib/magic-feedback";
import { MagicFeedbackWidget } from "@/lib/magic-feedback-widget";
import { cn } from "@/lib/utils";

// Magic feedback for everyone on GeoFinder (Daniel, 03.10: "everyone on
// GeoFinder can submit a magic feedback"). Alt+Shift+M (Mac: ⌥⇧M) starts and
// stops a recording; the review screen follows. Mounted once, at App level.
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

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.phase !== "recording") return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [state.phase]);

  if (state.phase === "recording" || state.phase === "reading") {
    const reading = state.phase === "reading";
    return (
      <Card
        data-mf-ui=""
        role="status"
        className="fixed bottom-5 right-5 z-[2147483000] flex-row items-center gap-2.5 rounded-full px-4 py-2.5 text-sm font-medium shadow-lg"
      >
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
      </Card>
    );
  }

  if (state.phase === "review" && state.reply) {
    return (
      <MagicReview
        initialNotes={state.notes}
        questions={state.reply.questions}
        onDiscard={() => widget.discard()}
        onSend={notes => void widget.send(notes)}
      />
    );
  }
  return null;
}
