import { Button } from "@/components/ui/button";

export interface CompShortfallPromptProps {
  remaining: number;
  quantity: number;
  onReduce: () => void;
  onRemove: () => void;
}

// Amber prompt shown on Step 2 when the requested quantity exceeds the passes
// remaining on an applied complimentary code. Pure presentational so it can
// be unit-tested in isolation.
export function CompShortfallPrompt({
  remaining,
  quantity,
  onReduce,
  onRemove,
}: CompShortfallPromptProps) {
  return (
    <div
      role="alert"
      data-testid="comp-shortfall-prompt"
      className="bg-amber-50 border border-amber-300 px-3 py-2.5 text-sm text-amber-900 space-y-2"
    >
      <p className="font-semibold">
        Only {remaining} complimentary pass{remaining === 1 ? "" : "es"}{" "}
        {remaining === 1 ? "remains" : "remain"} on this code, but you've selected {quantity}.
      </p>
      <p className="text-xs">
        Reduce your quantity to use the code, or remove the code to keep all {quantity} passes at
        the standard price.
      </p>
      <div className="flex flex-wrap gap-2 pt-1">
        {remaining > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 border-amber-400 bg-white hover:bg-amber-100"
            onClick={onReduce}
          >
            Reduce to {remaining} pass{remaining === 1 ? "" : "es"}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 border-amber-400 bg-white hover:bg-amber-100"
          onClick={onRemove}
        >
          Keep my quantity (remove code)
        </Button>
      </div>
    </div>
  );
}
