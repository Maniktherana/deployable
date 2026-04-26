import type { ReactNode } from "react";
import { Button } from "#/components/ui/button";
import { Spinner } from "#/components/ui/spinner";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "#/components/ui/dialog";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  /** Visible label on the confirm button; defaults to "Confirm". */
  confirmLabel?: string;
  /** Visible label on the cancel button; defaults to "Cancel". */
  cancelLabel?: string;
  /**
   * Variant of the confirm action — `destructive` paints the button in
   * destructive color so users know they're about to do something irreversible.
   */
  variant?: "default" | "destructive";
  /** Pending state for the confirm button (mutation in flight). */
  loading?: boolean;
  /** Called when the user clicks the confirm button. */
  onConfirm: () => void;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  loading = false,
  onConfirm,
}: Props) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter variant="bare">
          <Button
            disabled={loading}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            {cancelLabel}
          </Button>
          <Button
            disabled={loading}
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
            type="button"
            variant={variant === "destructive" ? "destructive" : "default"}
          >
            {loading && <Spinner className="size-3.5" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
