import { Platform } from "react-native";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";

/** Native stack already draws iOS chrome; Android still needs an in-screen bar. */
export function ScreenHeader(props: { readonly title: string; readonly onBack?: () => void }) {
  if (Platform.OS === "android") {
    return <AndroidScreenHeader title={props.title} onBack={props.onBack} />;
  }
  return <NativeStackScreenOptions options={{ title: props.title, headerShown: true }} />;
}
