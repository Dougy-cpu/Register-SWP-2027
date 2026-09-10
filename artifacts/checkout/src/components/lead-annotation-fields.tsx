import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface LeadAnnotation {
  note: string;
  rating: number | null;
}
// Presentation only: the caller owns saving. Public rehearsal never imports persistence.
export function LeadAnnotationFields({
  id,
  value,
  onChange,
}: {
  id: string;
  value: LeadAnnotation;
  onChange: (value: LeadAnnotation) => void;
}) {
  return (
    <>
      <div>
        <Label>Rating (optional)</Label>
        <div className="mt-2 flex gap-0.5 sm:gap-1.5" role="group" aria-label="Lead rating">
          {[1, 2, 3, 4, 5].map((rating) => (
            <Button
              key={rating}
              className="h-12 min-w-11 flex-1 px-0"
              variant={value.rating === rating ? "default" : "outline"}
              aria-pressed={value.rating === rating}
              aria-label={`Rate ${rating} out of 5`}
              onClick={() =>
                onChange({ ...value, rating: value.rating === rating ? null : rating })
              }
            >
              {rating}
            </Button>
          ))}
        </div>
      </div>
      <div>
        <Label htmlFor={`note-${id}`}>Notes</Label>
        <Textarea
          id={`note-${id}`}
          rows={4}
          maxLength={4000}
          className="mt-2 bg-white text-base"
          value={value.note}
          placeholder="What would you like to follow up on?"
          onChange={(event) => onChange({ ...value, note: event.target.value })}
        />
      </div>
    </>
  );
}
