import { createMemoryTools } from "./memory-tools.js";
import { createTaskTools } from "./task-tools.js";
import { createChromeTools } from "./chrome-tools.js";
import { createObjectiveTools } from "./objective-tools.js";
import { createSkillTools } from "./skill-tools.js";

export function createAllTools({
  memoryStore,
  backgroundManager,
  chromeController,
  objectiveQueue,
  skillManager,
}) {
  return [
    ...createTaskTools({ backgroundManager }),
    ...createChromeTools({ chromeController }),
    ...createMemoryTools({ memoryStore }),
    ...createObjectiveTools({ objectiveQueue }),
    ...(skillManager ? createSkillTools({ skillManager }) : []),
  ];
}
