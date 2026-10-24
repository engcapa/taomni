import "./tests/appStore/harness";
import { registerappStoreEditing1Cases } from "./tests/appStore/editing1.cases";
import { registerappStoreLayout3Cases } from "./tests/appStore/layout3.cases";
import { registerappStoreModeRouting1Cases } from "./tests/appStore/modeRouting1.cases";
import { registerappStoreNavigation2Cases } from "./tests/appStore/navigation2.cases";

registerappStoreEditing1Cases();

registerappStoreNavigation2Cases();

registerappStoreLayout3Cases();

registerappStoreModeRouting1Cases();
