import { Trash2 } from "lucide-react";
import { type Decision, type RuleMode, type SocksCapConfig, type SocksCapProfile, type UserRule } from "../../../lib/sockscap";
import { Field } from "./Field";
import { Section } from "./Section";

export interface RulesSectionProps {
  t: import("../../../lib/i18n").TranslateFn;
  linuxLaunchOnly: boolean;
  locked: boolean;
  selectedProf: SocksCapProfile;
  patchSelectedProfile: (partial: Partial<SocksCapProfile>) => Promise<SocksCapConfig | null>;
  newRule: UserRule;
  setNewRule: import("react").Dispatch<import("react").SetStateAction<UserRule>>;
  addUserRule: () => Promise<void>;
}

export function RulesSection(viewProps: RulesSectionProps) {
  return (<Section
    sectionId="rules"
    title={viewProps.t("sockscap.section.rules")}
    defaultExpanded={viewProps.linuxLaunchOnly}
  >
    <fieldset
      data-testid="sockscap-rules-editor"
      disabled={viewProps.locked}
      title={viewProps.locked ? viewProps.t("sockscap.lockedTooltip") : undefined}
      className="disabled:opacity-60"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
        <Field label={viewProps.t("sockscap.ruleMode")}>
          <select
            className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
            value={viewProps.selectedProf.ruleMode}
            onChange={(e) =>
              void viewProps.patchSelectedProfile({ ruleMode: e.target.value as RuleMode })
            }
          >
            <option value="gfwList">{viewProps.t("sockscap.ruleMode.gfwList")}</option>
            <option value="proxyAll">{viewProps.t("sockscap.ruleMode.proxyAll")}</option>
            <option value="off">{viewProps.t("sockscap.ruleMode.off")}</option>
          </select>
        </Field>
        <Field label={viewProps.t("sockscap.defaultAction")}>
          <select
            className="w-full text-[12px] px-2 py-1.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
            value={viewProps.selectedProf.defaultAction}
            onChange={(e) =>
              void viewProps.patchSelectedProfile({ defaultAction: e.target.value as Decision })
            }
          >
            <option value="direct">{viewProps.t("sockscap.action.direct")}</option>
            <option value="proxy">{viewProps.t("sockscap.action.proxy")}</option>
            <option value="block">{viewProps.t("sockscap.action.block")}</option>
          </select>
        </Field>
      </div>

      {/* User rules table for selected profile */}
      <div className="space-y-2">
        <div className="text-[11px] font-medium text-[var(--taomni-text-muted)]">
          {viewProps.t("sockscap.userRulesTitle")}
        </div>
        <div className="flex gap-2">
          <input
            className="flex-1 text-[12px] px-2 py-1 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
            placeholder={viewProps.t("sockscap.patternPh")}
            value={viewProps.newRule.pattern}
            onChange={(e) => viewProps.setNewRule({ ...viewProps.newRule, pattern: e.target.value })}
          />
          <select
            className="text-[12px] px-2 py-1 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-bg)]"
            value={viewProps.newRule.action}
            onChange={(e) =>
              viewProps.setNewRule({ ...viewProps.newRule, action: e.target.value as Decision })
            }
          >
            <option value="direct">{viewProps.t("sockscap.action.direct")}</option>
            <option value="proxy">{viewProps.t("sockscap.action.proxy")}</option>
            <option value="block">{viewProps.t("sockscap.action.block")}</option>
          </select>
          <button
            type="button"
            className="px-3 py-1 rounded text-[12px] bg-[var(--taomni-accent)] text-white hover:opacity-90"
            onClick={() => void viewProps.addUserRule()}
          >
            {viewProps.t("common.add")}
          </button>
        </div>

        {viewProps.selectedProf.userRules.length === 0 ? (
          <div className="text-[11px] text-[var(--taomni-text-muted)]">{viewProps.t("sockscap.userRulesEmpty")}</div>
        ) : (
          <ul className="space-y-1 max-h-36 overflow-auto">
            {viewProps.selectedProf.userRules.map((r, idx) => (
              <li
                key={`${r.pattern}-${idx}`}
                className="flex items-center gap-2 text-[12px] px-2 py-1 rounded bg-[var(--taomni-bg)] border border-[var(--taomni-divider)]"
              >
                <span className="font-mono flex-1">{r.pattern}</span>
                <span className="text-[11px] text-[var(--taomni-text-muted)] uppercase">
                  {r.action}
                </span>
                <button
                  type="button"
                  className="p-1 hover:text-red-500"
                  onClick={() =>
                    void viewProps.patchSelectedProfile({
                      userRules: viewProps.selectedProf.userRules.filter((_, i) => i !== idx),
                    })
                  }
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </fieldset>
  </Section>);
}
