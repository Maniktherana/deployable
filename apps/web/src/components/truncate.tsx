import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "#/components/ui/tooltip";
import { cn } from "#/lib/utils";

type Props = {
  /** Full text. The tooltip always shows this verbatim. */
  text: string;
  /** Optional rendered children — falls back to `text`. */
  children?: ReactNode;
  className?: string;
};

/**
 * Wraps a single line of potentially long text in a `<span>`. Shows a tooltip
 * with the full text only when the visible content is actually clipped, so we
 * don't spam tooltips on already-fitting strings.
 */
export function Truncate({ text, children, className }: Props) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const measure = () => {
      setOverflowing(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [text]);

  const inner = (
    <span ref={ref} className={cn("block truncate", className)}>
      {children ?? text}
    </span>
  );

  if (!overflowing) {
    return inner;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <span {...props} ref={ref} className={cn("block truncate", className)}>
            {children ?? text}
          </span>
        )}
      />
      <TooltipPopup className="max-w-[28rem] break-all px-2 py-1 font-mono text-xs">
        {text}
      </TooltipPopup>
    </Tooltip>
  );
}
