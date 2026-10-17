import type { RegistrationOrganization } from "@invintel/shared";
import { AuthField } from "@/components/auth-field";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

export interface OrgChoiceValue {
  mode: "create" | "join";
  name: string;
  joinCode: string;
}

export const initialOrgChoice: OrgChoiceValue = { mode: "create", name: "", joinCode: "" };

export const toOrgInput = (v: OrgChoiceValue): RegistrationOrganization =>
  v.mode === "create" ? { mode: "create", name: v.name } : { mode: "join", joinCode: v.joinCode };

const OPTIONS = [
  { value: "create", title: "Create a new organization", text: "Start fresh. You'll be the owner and can invite others." },
  { value: "join", title: "Join with a code", text: "Your team already has one. Ask an admin for the join code." },
] as const;

/** Radio toggle between starting an organization and joining one. Swaps the field underneath. */
export function OrgChoice({ value, onChange, idPrefix = "org" }: {
  value: OrgChoiceValue;
  onChange: (value: OrgChoiceValue) => void;
  idPrefix?: string;
}) {
  return (
    <fieldset className="grid gap-3">
      <legend className="mb-2 text-sm font-medium">Organization</legend>
      <RadioGroup
        value={value.mode}
        onValueChange={(mode) => onChange({ ...value, mode: mode as OrgChoiceValue["mode"] })}
        className="grid gap-2"
      >
        {OPTIONS.map((o) => (
          <Label
            key={o.value}
            htmlFor={`${idPrefix}-${o.value}`}
            className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors hover:bg-muted/50 has-data-checked:border-primary has-data-checked:bg-accent/50"
          >
            <RadioGroupItem value={o.value} id={`${idPrefix}-${o.value}`} className="mt-0.5" />
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">{o.title}</span>
              <span className="text-xs text-muted-foreground">{o.text}</span>
            </span>
          </Label>
        ))}
      </RadioGroup>
      {value.mode === "create" ? (
        <AuthField
          key="name"
          label="Organization name"
          id={`${idPrefix}-name`}
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          maxLength={100}
          required
        />
      ) : (
        <AuthField
          key="code"
          label="Join code"
          id={`${idPrefix}-code`}
          value={value.joinCode}
          onChange={(e) => onChange({ ...value, joinCode: e.target.value })}
          placeholder="ABCD-EFGH"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="font-mono uppercase"
          maxLength={9}
          required
        />
      )}
    </fieldset>
  );
}
