/**
 * Branded types for common IDs.
 *
 * Branded types use an intersection with a phantom readonly property so that
 * plain strings cannot be assigned to an ID slot without going through the
 * constructor function.  This prevents accidental mixing of unrelated IDs at
 * compile time while keeping zero runtime overhead (the brand property is
 * erased by the compiler).
 */
// ---------------------------------------------------------------------------
// Constructor functions
// ---------------------------------------------------------------------------
export function createRequestId(id) {
    return id;
}
export function createConversationId(id) {
    return id;
}
export function createTaskId(id) {
    return id;
}
export function createChannelId(id) {
    return id;
}
export function createGuildId(id) {
    return id;
}
export function createUserId(id) {
    return id;
}
export function createMemoryId(id) {
    return id;
}
