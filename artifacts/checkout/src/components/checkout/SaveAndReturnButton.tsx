import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";

const SUMMIT_WEBSITE_URL = "https://swpsummit.com";

interface SaveAndReturnButtonProps {
  onSave: () => Promise<void>;
  disabled?: boolean;
  className?: string;
  buttonClassName?: string;
}

export default function SaveAndReturnButton({
  onSave,
  disabled = false,
  className = "",
  buttonClassName = "",
}: SaveAndReturnButtonProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleClick = async () => {
    setIsSaving(true);
    setSaveError(null);

    try {
      await onSave();
      window.location.assign(SUMMIT_WEBSITE_URL);
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "We could not save your progress. Please check the highlighted fields and try again.",
      );
      setIsSaving(false);
    }
  };

  return (
    <div className={`flex flex-col items-stretch gap-2 w-full ${className}`}>
      <Button
        type="button"
        variant="outline"
        size="lg"
        className={`h-14 w-full min-w-0 px-5 border-border bg-white text-sm leading-tight text-center whitespace-normal sm:px-6 sm:text-base ${buttonClassName}`}
        onClick={handleClick}
        disabled={disabled || isSaving}
        aria-label="Save progress and return to the SWP Summit website"
      >
        <span className="min-w-0 flex-1 text-center">
          {isSaving ? "Saving..." : "Save and return to SWP Summit"}
        </span>
        <ArrowUpRight className="w-4 h-4 shrink-0" />
      </Button>
      {saveError && (
        <p className="max-w-sm text-center text-xs font-medium text-destructive" role="alert">
          {saveError}
        </p>
      )}
    </div>
  );
}
