import {
  CheckboxField, FieldNote, FormRow, NumberField, PasswordField, PathField,
  RadioField, SelectField, TextField,
} from "../../components/servers/fields";
import { getAppPlatform } from "../runtime";
import { openSystemRdpSettings, probeRdpCapture, probeSystemRdp } from "../servers";

const host = Object.freeze({
  fields: Object.freeze({
    CheckboxField, FieldNote, FormRow, NumberField, PasswordField, PathField,
    RadioField, SelectField, TextField,
  }),
  runtime: Object.freeze({ getAppPlatform }),
  commands: Object.freeze({ openSystemRdpSettings, probeRdpCapture, probeSystemRdp }),
});

export type ServerSettingsRendererHost = typeof host;

export function installServerSettingsRendererHost() {
  Object.defineProperty(globalThis, "__taomniServerSettingsRendererHost", { value: host });
}
