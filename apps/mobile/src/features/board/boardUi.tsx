import { AppBar } from "../../components/ui/AppBar";
import type { AppBarMenu } from "../../components/ui/AppBar.types";

/** Native stack already draws iOS chrome; Android still needs an in-screen bar. */
export function ScreenHeader(props: {
  readonly title: string;
  readonly onBack?: () => void;
  readonly menus?: ReadonlyArray<AppBarMenu>;
}) {
  return <AppBar title={props.title} onBack={props.onBack} menus={props.menus} sidebar={false} />;
}
