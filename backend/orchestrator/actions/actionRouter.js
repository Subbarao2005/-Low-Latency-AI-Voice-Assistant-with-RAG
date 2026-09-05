const { ACTIONS } = require("./actionRegistry");

function failure(action, code, message, statusCode) {
  const result = { success: false, action, error: { code, message } };
  if (statusCode) Object.defineProperty(result, "statusCode", { value: statusCode, enumerable: false });
  return result;
}

async function routeAction(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return failure(undefined, "INVALID_REQUEST", "Invalid action request");
  }

  if (request.type !== undefined && request.type !== "action") {
    return failure(request.action, "INVALID_REQUEST", "Invalid action request type");
  }

  const handler = ACTIONS[request.action];
  if (!handler) {
    return failure(request.action, "UNSUPPORTED_ACTION", "Unsupported action");
  }

  if (request.data !== undefined && (!request.data || typeof request.data !== "object" || Array.isArray(request.data))) {
    return failure(request.action, "INVALID_REQUEST", "Action data must be an object");
  }

  try {
    return await handler(request.data || {});
  } catch (error) {
    return failure(
      request.action,
      error.code || "ACTION_ERROR",
      error.publicMessage || "Action could not be completed",
      error.statusCode
    );
  }
}

module.exports = { routeAction, registeredActions: Object.keys(ACTIONS), ACTIONS };