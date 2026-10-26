import { proxy, useSnapshot } from "valtio";

const MAX_ROWS = 6;

interface ChatInputStoreProps {
  rows: number;
  keysPressed: Set<string>;
}

const state = proxy<ChatInputStoreProps>({
  rows: 1,
  keysPressed: new Set(),
});

export const SetInputRows = (rows: number) => {
  if (rows < MAX_ROWS) {
    state.rows = rows + 1;
  }
};

export const SetInputRowsToMax = () => {
  state.rows = MAX_ROWS;
};

export const ResetInputRows = () => {
  state.rows = 1;
};

export const onKeyDown = (
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  submit: () => void
) => {
  state.keysPressed.add(event.key);
  // Focus may move on Shift+Tab before keyup reaches this textarea.
  // Read modifiers from the current event instead of retaining a stale Shift.
  if (event.key === "Enter" && event.shiftKey) {
    SetInputRows(state.rows + 1);
  }

  if (
    !event.nativeEvent.isComposing &&
    event.key === "Enter" &&
    !event.shiftKey
  ) {
    submit();
    ResetInputRows();
    event.preventDefault();
  }
};

export const onKeyUp = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
  state.keysPressed.delete(event.key);
};

export const useChatInputDynamicHeight = () => {
  return useSnapshot(state);
};
