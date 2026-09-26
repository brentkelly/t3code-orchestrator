import * as Schema from "effect/Schema";
import { deriveProjectIdentity } from "../../projectIdentity";
import { ProjectMonogram } from "../ProjectMonogram";
import { ProjectMonogramText, type ProjectIconOverride } from "@t3tools/contracts";
import { DynamicIcon, type IconName } from "lucide-react/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  filterProjectIconNames,
  firstEmoji,
  isPaletteColor,
  parseHexColor,
  PROJECT_EMOJIS,
  PROJECT_ICON_COLORS,
  resolveProjectIconColor,
} from "../../projectIconOptions";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const DEFAULT_ICON: IconName = "folder-code";
const isMonogramText = Schema.is(ProjectMonogramText);

function iconLabel(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function ProjectIconPickerDialog({
  current,
  projectName,
  open,
  onOpenChange,
  onSelect,
}: {
  readonly current: ProjectIconOverride | null;
  readonly projectName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (icon: ProjectIconOverride) => void;
}) {
  const automatic = deriveProjectIdentity(projectName);
  const [mode, setMode] = useState<ProjectIconOverride["kind"] | "monogram">(
    current?.kind === "lucide" && current.monogram ? "monogram" : (current?.kind ?? "lucide"),
  );
  const [iconName, setIconName] = useState<IconName>(
    current?.kind === "lucide" ? (current.name as IconName) : DEFAULT_ICON,
  );
  const [color, setColor] = useState(() =>
    resolveProjectIconColor(current && current.kind !== "emoji" ? current.color : automatic.color),
  );
  const [hexDraft, setHexDraft] = useState(color);
  const [letters, setLetters] = useState(
    current?.kind === "lucide" && current.monogram ? current.monogram : automatic.monogram,
  );
  const [emoji, setEmoji] = useState(current?.kind === "emoji" ? current.emoji : "💻");
  const [query, setQuery] = useState("");
  const [customEmoji, setCustomEmoji] = useState("");
  const previousOpenRef = useRef(false);

  useEffect(() => {
    if (open && !previousOpenRef.current) {
      setMode(
        current?.kind === "lucide" && current.monogram ? "monogram" : (current?.kind ?? "lucide"),
      );
      setIconName(current?.kind === "lucide" ? (current.name as IconName) : DEFAULT_ICON);
      const nextColor = resolveProjectIconColor(
        current && current.kind !== "emoji" ? current.color : automatic.color,
      );
      setColor(nextColor);
      setHexDraft(nextColor);
      setLetters(
        current?.kind === "lucide" && current.monogram ? current.monogram : automatic.monogram,
      );
      setEmoji(current?.kind === "emoji" ? current.emoji : "💻");
      setQuery("");
      setCustomEmoji("");
    }
    previousOpenRef.current = open;
  }, [current, open, automatic.color, automatic.monogram]);

  const icons = useMemo(() => filterProjectIconNames(query), [query]);
  const monogram = letters.normalize("NFKC").trim().toUpperCase();
  const validMonogram = isMonogramText(monogram);
  const validColor = parseHexColor(hexDraft) !== null;
  const colorBlocksSave = mode !== "emoji" && !validColor;
  const applyHexDraft = (value: string) => {
    setHexDraft(value);
    const parsed = parseHexColor(value);
    if (parsed) setColor(parsed);
  };
  const selectColor = (hex: string) => {
    setColor(hex);
    setHexDraft(hex);
  };
  const save = () => {
    if (mode === "monogram" && !validMonogram) return;
    if (colorBlocksSave) return;
    onSelect(
      mode === "monogram"
        ? { kind: "lucide", name: DEFAULT_ICON, monogram, color }
        : mode === "lucide"
          ? { kind: "lucide", name: iconName, color }
          : { kind: "emoji", emoji },
    );
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:w-[32rem]">
        <DialogHeader>
          <DialogTitle>Choose project icon</DialogTitle>
          <DialogDescription>Choose an icon, emoji, or monogram.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex min-h-0 flex-col gap-4">
          <ToggleGroup
            aria-label="Icon type"
            variant="segmented"
            value={[mode]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "lucide" || value === "emoji" || value === "monogram") setMode(value);
            }}
          >
            <Toggle value="lucide">Icons</Toggle>
            <Toggle value="emoji">Emoji</Toggle>
            <Toggle value="monogram">Monogram</Toggle>
          </ToggleGroup>

          {mode !== "emoji" ? (
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">Color</div>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Icon color">
                {PROJECT_ICON_COLORS.map((option) => (
                  <button
                    key={option.hex}
                    type="button"
                    aria-label={option.label}
                    aria-pressed={color === option.hex}
                    className={cn(
                      "flex size-6 items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      color === option.hex && "border-foreground/64",
                    )}
                    onClick={() => selectColor(option.hex)}
                  >
                    <span className="size-4 rounded-full" style={{ backgroundColor: option.hex }} />
                  </button>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border border-dashed border-foreground/32 focus-within:ring-2 focus-within:ring-ring",
                    validColor && !isPaletteColor(color) && "border-foreground/64 border-solid",
                  )}
                >
                  <input
                    type="color"
                    aria-label="Custom color"
                    value={validColor ? color : "#000000"}
                    className="size-4 cursor-pointer appearance-none rounded-full border-none bg-transparent p-0 outline-none [&::-moz-color-swatch]:rounded-full [&::-moz-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-none"
                    onChange={(event) => selectColor(event.currentTarget.value.toLowerCase())}
                  />
                </span>
                <Input
                  value={hexDraft}
                  size="compact"
                  aria-label="Hex color"
                  aria-invalid={!validColor}
                  placeholder="#4f7db3"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-24 font-mono"
                  onChange={(event) => applyHexDraft(event.currentTarget.value)}
                />
                <span className="text-xs text-muted-foreground">Or pick any color</span>
              </div>
            </div>
          ) : null}

          {mode === "lucide" ? (
            <>
              <Input
                type="search"
                value={query}
                aria-label="Search Lucide icons"
                placeholder="Search all Lucide icons"
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
              <ScrollArea scrollFade className="max-h-64">
                <div className="grid grid-cols-8 gap-1 p-0.5 sm:grid-cols-10">
                  {icons.map((name) => (
                    <button
                      key={name}
                      type="button"
                      aria-label={iconLabel(name)}
                      aria-pressed={iconName === name}
                      className={cn(
                        "flex aspect-square items-center justify-center rounded-md border border-transparent outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                        iconName === name && "border-border bg-accent",
                      )}
                      style={validColor ? { color } : undefined}
                      onClick={() => setIconName(name)}
                    >
                      <DynamicIcon name={name} className="size-5" />
                    </button>
                  ))}
                </div>
              </ScrollArea>
              {icons.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No icons found.</p>
              ) : null}
            </>
          ) : mode === "monogram" ? (
            <div className="flex items-center gap-4 py-2">
              <ProjectMonogram
                text={validMonogram ? monogram : automatic.monogram}
                color={color}
                className="size-12"
              />
              <div className="flex-1 space-y-2">
                <label htmlFor="project-monogram" className="text-sm font-medium">
                  Letters
                </label>
                <Input
                  id="project-monogram"
                  value={letters}
                  onChange={(event) => setLetters(event.currentTarget.value)}
                  aria-describedby="project-monogram-hint"
                  aria-invalid={!validMonogram}
                  autoComplete="off"
                />
                <p id="project-monogram-hint" className="text-xs text-muted-foreground">
                  One or two letters or numbers.
                </p>
              </div>
            </div>
          ) : (
            <>
              <ScrollArea scrollFade className="max-h-64">
                <div className="grid grid-cols-8 gap-1 p-0.5 sm:grid-cols-10">
                  {PROJECT_EMOJIS.map((option) => (
                    <button
                      key={option.emoji}
                      type="button"
                      aria-label={option.label}
                      aria-pressed={emoji === option.emoji}
                      className={cn(
                        "flex aspect-square items-center justify-center rounded-md border border-transparent text-xl outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                        emoji === option.emoji && "border-border bg-accent",
                      )}
                      onClick={() => setEmoji(option.emoji)}
                    >
                      {option.emoji}
                    </button>
                  ))}
                </div>
              </ScrollArea>
              <div>
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  Or paste any emoji
                </div>
                <Input
                  value={customEmoji}
                  aria-label="Custom emoji"
                  placeholder="Paste an emoji"
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setCustomEmoji(value);
                    const nextEmoji = firstEmoji(value);
                    if (nextEmoji) setEmoji(nextEmoji);
                  }}
                />
              </div>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={(mode === "monogram" && !validMonogram) || colorBlocksSave}
          >
            Save icon
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
