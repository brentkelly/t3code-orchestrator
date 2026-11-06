import { View } from "react-native";

import { SegmentedControl } from "../../components/SegmentedControl";
import type { HomeMode } from "./boardHomeMode";

export function HomeModeBar(props: {
  readonly mode: HomeMode;
  readonly onChange: (mode: HomeMode) => void;
}) {
  return (
    <View className="bg-header px-4 pb-2 pt-1">
      <SegmentedControl
        size="compact"
        role="tab"
        selected={props.mode}
        onSelect={props.onChange}
        options={[
          { value: "threads", label: "Threads" },
          { value: "board", label: "Board" },
        ]}
      />
    </View>
  );
}
