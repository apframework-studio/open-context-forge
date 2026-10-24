import * as Select from "@radix-ui/react-select";

interface Option { value: string; label: string }
interface Props {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  className?: string;
  title?: string;
}

const optionValue = (value: string) => value === "" ? "all" : `value:${value}`;

export function WorkbenchSelect({ label, value, options, onChange, className = "", title }: Props) {
  return <Select.Root value={optionValue(value)} onValueChange={(next) => onChange(next === "all" ? "" : next.slice(6))}>
    <Select.Trigger className={`workbench-select-trigger ${className}`} aria-label={label} title={title}>
      <Select.Value />
      <Select.Icon className="workbench-select-icon" aria-hidden="true"><span className="workbench-select-chevron" /></Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Content className="workbench-select-menu" position="popper" side="bottom" align="start" sideOffset={5}
        collisionPadding={8} aria-label={`${label}选项`}>
        <Select.Viewport className="workbench-select-options">
          {options.map((option) => <Select.Item className="workbench-select-option" key={optionValue(option.value)} value={optionValue(option.value)}>
            <Select.ItemText>{option.label}</Select.ItemText>
            <Select.ItemIndicator className="workbench-select-check" aria-hidden="true">✓</Select.ItemIndicator>
          </Select.Item>)}
        </Select.Viewport>
      </Select.Content>
    </Select.Portal>
  </Select.Root>;
}
