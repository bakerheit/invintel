import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/** "Inspect before release": what arrives goes straight on quality hold until someone decides. */
export function InspectToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Button
      type="button"
      variant={value ? "default" : "outline"}
      aria-pressed={value}
      className="h-14 w-full justify-start text-base"
      onClick={() => onChange(!value)}
    >
      <ShieldAlert /> {value ? "Inspect before release: on" : "Inspect before release"}
    </Button>
  );
}
