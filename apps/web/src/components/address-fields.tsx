import { BLANK_ADDRESS, type Address } from "@invintel/shared";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** The fields of one postal address. Leave them all empty for no address. `idPrefix` keeps the ids apart when a form has two. */
export function AddressFields({ value, onChange, idPrefix, disabled, withName = true }: { value: Address; onChange: (a: Address) => void; idPrefix: string; disabled?: boolean; withName?: boolean }) {
  const set = (patch: Partial<Address>) => onChange({ ...value, ...patch });
  const f = (key: keyof Address, label: string, max: number, extra?: { className?: string; placeholder?: string }) => (
    <div className={`grid gap-1.5 ${extra?.className ?? ""}`}>
      <Label htmlFor={`${idPrefix}-${key}`}>{label}</Label>
      <Input id={`${idPrefix}-${key}`} disabled={disabled} value={value[key]} maxLength={max} placeholder={extra?.placeholder} onChange={(e) => set({ [key]: e.target.value })} />
    </div>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-6">
      {withName && f("name", "Place (if not the business itself)", 100, { className: "sm:col-span-6", placeholder: "Plant 2, receiving dock" })}
      {f("line1", "Street", 55, { className: "sm:col-span-6" })}
      {f("line2", "Street, second line", 55, { className: "sm:col-span-6" })}
      {f("city", "City", 30, { className: "sm:col-span-3" })}
      {f("region", "State or province", 30, { className: "sm:col-span-1", placeholder: "IL" })}
      {f("postal", "Postal code", 15, { className: "sm:col-span-2" })}
      {f("country", "Country", 56, { className: "sm:col-span-3", placeholder: "US" })}
    </div>
  );
}

export const blankAddress = (): Address => ({ ...BLANK_ADDRESS });
export const orBlank = (a?: Address | null): Address => ({ ...BLANK_ADDRESS, ...(a ?? {}) });
/** A form's address as the API takes it: null when nothing was typed. */
export const addressOrNull = (a: Address): Address | null => (Object.values(a).every((v) => !String(v).trim()) ? null : a);
