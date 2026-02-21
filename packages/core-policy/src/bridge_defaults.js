const { DEFAULT_ROUTE_PROFILE_MAP } = require('../../core-routing/src/route_profile_map');

const DEFAULT_COMMAND_ALLOWLIST = Object.freeze({
  enabled: true,
  directCommands: [
    'auto', 'work', 'inspect', 'deploy', 'project', 'ops', 'word',
    'news', 'prompt', 'finance', 'todo', 'routine', 'workout', 'media', 'place',
  ],
  autoRoutes: [
    'word', 'memo', 'news', 'report', 'work', 'inspect', 'deploy', 'project',
    'prompt', 'link', 'status', 'ops', 'finance', 'todo', 'routine', 'workout', 'media', 'place',
  ],
});

const DEFAULT_HUB_DELEGATION = Object.freeze({
  enabled: false,
  fallbackPolicy: 'local',
  routeToProfile: DEFAULT_ROUTE_PROFILE_MAP,
});

const DEFAULT_NATURAL_LANGUAGE_ROUTING = Object.freeze({
  enabled: true,
  hubOnly: true,
  inferMemo: true,
  inferFinance: true,
  inferTodo: true,
  inferRoutine: true,
  inferWorkout: true,
  inferPersona: true,
  inferBrowser: true,
  inferSchedule: true,
  inferStatus: true,
  inferLink: true,
  inferWork: true,
  inferInspect: true,
  inferReport: true,
  inferProject: true,
});

module.exports = {
  DEFAULT_COMMAND_ALLOWLIST,
  DEFAULT_HUB_DELEGATION,
  DEFAULT_NATURAL_LANGUAGE_ROUTING,
};
