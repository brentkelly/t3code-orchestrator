import { StackActions, useNavigation } from "@react-navigation/native";
import { useAtomSet } from "@effect/atom-react";
import { useEffect } from "react";

import { LoadingScreen } from "../../components/LoadingScreen";
import { updateMobilePreferencesAtom } from "../../state/preferences";

/** Deep-link `/board` lands here, persists Board mode, and replaces Home. */
export function BoardLandingScreen() {
  const navigation = useNavigation();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  useEffect(() => {
    savePreferences({ homeMode: "board" });
    navigation.dispatch(StackActions.replace("Home"));
  }, [navigation, savePreferences]);
  return <LoadingScreen message="Opening board" />;
}
