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

/** Radio toggle between starting an organization and joining one. Swaps the field underneath. */
export function OrgChoice({ value, onChange, idPrefix = "org" }: {
  value: OrgChoiceValue;
  onChange: (value: OrgChoiceValue) => void;
  idPrefix?: string;
}) {
  return (
    <fieldset className="grid gap-3">
      <legend className="mb-1 text-sm font-medium">Organization</legend>
      <RadioGroup
        value={value.mode}
        onValueChange={(mode) => onChange({ ...value, mode: mode as OrgChoiceValue["mode"] })}
        className="grid gap-2"
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem value="create" id={`${idPrefix}-create`} />
          <Label htmlFor={`${idPrefix}-create`} className="font-normal">Create a new organization</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="join" id={`${idPrefix}-join`} />
          <Label htmlFor={`${idPrefix}-join`} className="font-normal">Join with a code</Label>
        </div>
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
