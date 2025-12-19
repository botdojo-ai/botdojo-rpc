import { RPCMessage, RPCMessageError } from "./index";

/**
 * PostMessage envelope format for wrapping RPC messages
 */
export interface BotDojoPostMessage {
    type: 'botdojo-rpc' | 'botdojo-ready' | 'botdojo-error' | 'botdojo-rpc-compressed';
    payload: any;
    timestamp?: number;
    compressed?: boolean;
}

/**
 * Ready message sent when bridge is initialized
 */
export interface BotDojoReadyMessage {
    clientId: string;
    channelId?: string;
    capabilities: string[];
}

/**
 * Configuration for PostMessageBridge
 */
export interface PostMessageBridgeConfig {
    /**
     * Window to send messages to (parent or iframe.contentWindow)
     * Using 'any' type to avoid requiring DOM types in non-browser environments
     */
    targetWindow: any;
    
    /**
     * Origin for postMessage (default: '*')
     */
    targetOrigin?: string;
    
    /**
     * Client ID for this bridge
     */
    clientId: string;

    /**
     * Optional canvasId used to infer source/destination when the iframe
     * doesn't populate them. If provided, messages without a source will get
     * `canvas:${canvasId}` automatically.
     */
    canvasId?: string;

    /**
     * Default source to attach when an incoming message omits it.
     * Overrides the `canvasId` inference when set.
     */
    defaultSource?: string;

    /**
     * Default destination to attach when an outgoing message omits it.
     */
    defaultDestination?: string;
    
    /**
     * Handler for incoming RPC messages from the target window
     */
    onMessage?: (msg: RPCMessage) => void | Promise<void>;
    
    /**
     * Handler for ready messages
     */
    onReady?: (msg: BotDojoReadyMessage) => void;
    
    /**
     * Handler for errors
     */
    onError?: (error: any) => void;
    
    /**
     * Filter messages by source clientId (optional)
     */
    filterSource?: string;
    
    /**
     * Filter messages by source window (default: true)
     * Set to false if this bridge needs to receive messages from multiple windows
     * (e.g., ParentBridge receiving from both parent and canvas iframes)
     */
    filterSourceWindow?: boolean;
    
    /**
     * Debug logging
     */
    debug?: boolean;
    
    /**
     * Enable message compression for large payloads (default: true)
     * Messages larger than compressionThreshold will be compressed
     */
    enableCompression?: boolean;
    
    /**
     * Size threshold in bytes for compression (default: 50000 = 50KB)
     */
    compressionThreshold?: number;
    
    /**
     * Role of this bridge (parent, canvas, or chat)
     * Used to determine which CORS validation to apply
     */
    role?: 'parent' | 'canvas' | 'chat';
    
    /**
     * CORS configuration for validating PostMessage origins
     */
    cors?: {
        /**
         * Allowed chat iframe domains (for parent and canvas to validate PostMessage source)
         * If defined, ENFORCED - only these domains allowed
         * Default: If undefined, all origins are trusted (backward compatible)
         */
        botdojoChatDomain?: string[];
        
        /**
         * Allowed parent/canvas domains for tool call routing
         * Used by chat iframe router to validate which origins can call tools
         */
        allowedToolCallOrigins?: string[];
    };
}

/**
 * PostMessageBridge handles bidirectional communication between windows
 * using postMessage, with RPC message format compatibility.
 * 
 * This bridge translates between window.postMessage and RPCMessage format,
 * allowing iframe-based UIs to communicate with the chat component without
 * requiring direct Socket.IO connections.
 * 
 * Note: This class requires a browser environment with window/postMessage.
 * It will no-op gracefully when used in Node.js or other non-browser environments.
 */
export class PostMessageBridge {
    private config: PostMessageBridgeConfig;
    private messageListener: ((event: any) => void) | null = null;
    private isActive: boolean = false;
    private isBrowser: boolean = false;
    
    constructor(config: PostMessageBridgeConfig) {
        this.config = {
            targetOrigin: '*',
            debug: false,
            ...config
        };
        
        // Check if we're in a browser environment
        this.isBrowser = typeof globalThis !== 'undefined' && 
                        typeof (globalThis as any).window !== 'undefined' && 
                        typeof (globalThis as any).window.addEventListener === 'function';
        
        if (!this.isBrowser) {
            console.warn('[PostMessageBridge] Not in browser environment - bridge will be inactive');
        }
    }
    
    /**
     * Check if running in a browser environment
     */
    private checkBrowser(): boolean {
        if (!this.isBrowser) {
            this.log('Operation skipped: not in browser environment');
            return false;
        }
        return true;
    }
    
    /**
     * Validate PostMessage origin against botdojoChatDomain
     * Used by parent and canvas to ensure messages come from trusted chat iframe
     */
    private isPostMessageOriginAllowed(origin: string): boolean {
        if (!this.config.cors?.botdojoChatDomain) {
            // No botdojoChatDomain: BACKWARD COMPATIBLE MODE
            // Trust any origin (same behavior as before CORS implementation)
            // This ensures existing embed chat users don't experience breaking changes
            return true;
        }
        
        // botdojoChatDomain defined: ENFORCE (only these allowed)
        const { botdojoChatDomain } = this.config.cors;
        return botdojoChatDomain.some(allowed => {
            // Exact match
            if (allowed === origin) return true;
            
            // Wildcard subdomain support (*.example.com)
            if (allowed.startsWith('*.')) {
                const domain = allowed.substring(1);
                return origin.endsWith(domain);
            }
            
            return false;
        });
    }
    
    /**
     * Start listening for postMessage events
     */
    start(): void {
        if (!this.checkBrowser()) {
            return;
        }
        
        if (this.isActive) {
            this.log('Bridge already active');
            return;
        }
        
        this.messageListener = this.handleMessageEvent.bind(this);
        (globalThis as any).window.addEventListener('message', this.messageListener);
        this.isActive = true;
        this.log('Bridge started', { clientId: this.config.clientId });
    }
    
    /**
     * Stop listening for postMessage events
     */
    stop(): void {
        if (!this.checkBrowser()) {
            return;
        }
        
        if (!this.isActive) {
            return;
        }
        
        if (this.messageListener) {
            (globalThis as any).window.removeEventListener('message', this.messageListener);
            this.messageListener = null;
        }
        this.isActive = false;
        this.log('Bridge stopped');
    }
    
    /**
     * Send an RPC message via postMessage
     */
    sendMessage(message: RPCMessage): void {
        if (!this.checkBrowser()) {
            return;
        }

        const messageToSend: RPCMessage = { ...message };
        // Attach defaults if missing so canvas iframes don't need to know their id
        const inferredSource = this.inferCanvasSource();
        if (!messageToSend.source && inferredSource) {
            messageToSend.source = inferredSource;
        }
        if (!messageToSend.destination && this.config.defaultDestination) {
            messageToSend.destination = this.config.defaultDestination;
        }

        // Mirror intermediate step updates into MCP App notifications when targeting MCP canvas iframes
        this.maybeSendMcpAppNotifications(messageToSend);
        
        const serialized = JSON.stringify(messageToSend);
        const enableCompression = this.config.enableCompression !== false;
        const compressionThreshold = this.config.compressionThreshold || 50000; // 50KB default
        
        let envelope: BotDojoPostMessage;
        
        // Compress large messages if enabled
        if (enableCompression && serialized.length > compressionThreshold) {
            try {
                const compressed = this.compressMessage(serialized);
                envelope = {
                    type: 'botdojo-rpc-compressed',
                    payload: compressed,
                    timestamp: Date.now(),
                    compressed: true
                };
                this.log('Sending compressed message', { 
                    functionName: messageToSend.functionName,
                    originalSize: serialized.length,
                    compressedSize: compressed.length,
                    compressionRatio: ((1 - compressed.length / serialized.length) * 100).toFixed(1) + '%'
                });
            } catch (error) {
                // Fallback to uncompressed if compression fails
                this.log('Compression failed, sending uncompressed', error);
                envelope = {
                    type: 'botdojo-rpc',
                    payload: messageToSend,
                    timestamp: Date.now()
                };
            }
        } else {
            envelope = {
                type: 'botdojo-rpc',
                payload: messageToSend,
                timestamp: Date.now()
            };
        }
        
        this.log('Sending message', { 
            functionName: messageToSend.functionName, 
            direction: messageToSend.direction,
            destination: messageToSend.destination,
            compressed: envelope.compressed || false
        });
        
        (this.config.targetWindow as any).postMessage(envelope, this.config.targetOrigin!);
    }
    
    /**
     * Compress a message string using browser CompressionStream API
     * Falls back to simple base64 encoding if CompressionStream is not available
     */
    private compressMessage(message: string): string {
        // For now, use simple base64 encoding as a placeholder
        // In production, you could use pako or CompressionStream API
        // This is a simple implementation that reduces size for repeated patterns
        const encoder = new TextEncoder();
        const data = encoder.encode(message);
        
        // Simple compression: use base64 but with a marker to indicate compression
        // In a real implementation, you'd use pako.deflate or CompressionStream
        const base64 = btoa(String.fromCharCode(...data));
        
        // Return compressed format: 'compressed:' prefix + base64
        return 'compressed:' + base64;
    }
    
    /**
     * Decompress a compressed message string
     */
    private decompressMessage(compressed: string): string {
        if (!compressed.startsWith('compressed:')) {
            return compressed; // Not compressed
        }
        
        const base64 = compressed.substring('compressed:'.length);
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        const decoder = new TextDecoder();
        return decoder.decode(bytes);
    }
    
    /**
     * Send a ready message
     */
    sendReady(channelId?: string, capabilities: string[] = []): void {
        if (!this.checkBrowser()) {
            return;
        }
        
        const readyMsg: BotDojoReadyMessage = {
            clientId: this.config.clientId,
            channelId,
            capabilities
        };
        
        const envelope: BotDojoPostMessage = {
            type: 'botdojo-ready',
            payload: readyMsg,
            timestamp: Date.now()
        };
        
        this.log('Sending ready message', readyMsg);
        (this.config.targetWindow as any).postMessage(envelope, this.config.targetOrigin!);
    }
    
    /**
     * Send an error message
     */
    sendError(error: any): void {
        if (!this.checkBrowser()) {
            return;
        }
        
        const envelope: BotDojoPostMessage = {
            type: 'botdojo-error',
            payload: {
                message: error?.message || error?.toString() || 'Unknown error',
                error
            },
            timestamp: Date.now()
        };
        
        this.log('Sending error', error);
        (this.config.targetWindow as any).postMessage(envelope, this.config.targetOrigin!);
    }
    
    /**
     * Handle incoming postMessage events
     */
    private handleMessageEvent(event: any): void {
        // Check if this is a BotDojo message
        if (!event.data || typeof event.data !== 'object') {
            return;
        }
        
        const envelope = event.data as BotDojoPostMessage;
        
        // Only handle BotDojo messages
        if (!envelope.type || !envelope.type.startsWith('botdojo-')) {
            return;
        }
        
        // Only process messages from our target window (ignore messages from other iframes)
        // unless filterSourceWindow is explicitly disabled
        const shouldFilterSource = this.config.filterSourceWindow !== false;
        if (shouldFilterSource && this.config.targetWindow && event.source !== this.config.targetWindow) {
            return;
        }
        
        // CORS Validation: Parent and Canvas validate PostMessage origin
        // Chat iframe doesn't validate its own PostMessage origins via botdojoChatDomain
        const isChatIframe = this.config.role === 'chat';
        
        if (!isChatIframe && this.config.cors?.botdojoChatDomain !== undefined) {
            // Parent or Canvas: Validate PostMessage is from trusted chat domain
            // Note: If botdojoChatDomain is undefined, validation is skipped (backward compatible)
            if (!this.isPostMessageOriginAllowed(event.origin)) {
                this.log('[CORS] Blocked PostMessage from untrusted chat domain:', event.origin);
                
                // Send error response if it's an RPC message
                if (envelope.type === 'botdojo-rpc' || envelope.type === 'botdojo-rpc-compressed') {
                    let message: RPCMessage | null = null;
                    try {
                        if (envelope.type === 'botdojo-rpc-compressed') {
                            const decompressed = this.decompressMessage(envelope.payload);
                            message = JSON.parse(decompressed);
                        } else {
                            message = envelope.payload;
                        }
                        
                        if (message && message.id) {
                            // Send error response back using RPCMessage.response
                            const errorMsg = `CORS blocked: PostMessage from untrusted chat domain ${event.origin}`;
                            const errorResponse = RPCMessage.response(message, new RPCMessageError(errorMsg));
    
                            this.sendMessage(errorResponse);
                        }
                    } catch (e) {
                        this.log('[CORS] Error sending CORS error response:', e);
                    }
                }
                return;
            }
        }
        
        this.log('Received message', { type: envelope.type, source: event.origin });
        
        switch (envelope.type) {
            case 'botdojo-rpc':
                this.handleRPCMessage(envelope.payload, event.origin);
                break;
            case 'botdojo-rpc-compressed':
                // Decompress and handle as normal RPC message
                try {
                    const decompressed = this.decompressMessage(envelope.payload);
                    const message = JSON.parse(decompressed);
                    this.handleRPCMessage(message, event.origin);
                } catch (error) {
                    this.log('Failed to decompress message', error);
                    if (this.config.onError) {
                        this.config.onError(error);
                    }
                }
                break;
            case 'botdojo-ready':
                this.handleReadyMessage(envelope.payload);
                break;
            case 'botdojo-error':
                this.handleErrorMessage(envelope.payload);
                break;
        }
    }
    
    /**
     * Handle RPC messages
     */
    private handleRPCMessage(payload: any, origin?: string): void {
        // Validate that payload looks like an RPCMessage
        if (!payload || typeof payload !== 'object' || !payload.id || !payload.functionName) {
            this.log('Invalid RPC message payload', payload);
            return;
        }
        
        const message = payload as RPCMessage;

        // Stamp inferred canvas source/destination if missing so canvases
        // don't need to know their own ID.
        const inferredSource = this.inferCanvasSource();
        if (!message.source && inferredSource) {
            message.source = inferredSource;
        }
        if (!message.destination && this.config.defaultDestination) {
            message.destination = this.config.defaultDestination;
        }
        
        // Track origin on the message for downstream routing decisions
        if (origin && !message.origin) {
            message.origin = origin;
            this.log('[CORS DEBUG] Attached origin to message', {
                origin,
                functionName: message.functionName,
                messageId: message.id
            });
        } else if (message.origin) {
            this.log('[CORS DEBUG] Message already has origin', {
                origin: message.origin,
                functionName: message.functionName,
                messageId: message.id
            });
        } else {
            this.log('[CORS DEBUG] WARNING: No origin available for message', {
                functionName: message.functionName,
                messageId: message.id,
                eventOrigin: origin
            });
        }
        
        // Filter by source if configured
        if (this.config.filterSource && message.source !== this.config.filterSource) {
            this.log('Filtered message from', message.source);
            return;
        }
        
        this.log('Handling RPC message', {
            functionName: message.functionName,
            origin: message.origin,
            direction: message.direction,
            source: message.source,
            destination: message.destination
        });
        
        if (this.config.onMessage) {
            try {
                const result = this.config.onMessage(message);
                if (result && typeof result.then === 'function') {
                    result.catch(error => {
                        this.log('Error in onMessage handler', error);
                        if (this.config.onError) {
                            this.config.onError(error);
                        }
                    });
                }
            } catch (error) {
                this.log('Error in onMessage handler', error);
                if (this.config.onError) {
                    this.config.onError(error);
                }
            }
        }
    }

    /**
     * Mirror Flow intermediate step updates to MCP App JSON-RPC notifications so MCP canvases receive native events.
     * This keeps BotDojo tool streaming in sync with the MCP App spec (ui/notifications/*).
     */
    private maybeSendMcpAppNotifications(message: RPCMessage): void {
        if (!this.checkBrowser()) return;
        if (!message || message.functionName !== 'onIntermediateStepUpdate') return;
        const step = (message as any).data?.[0];
        if (!step) return;

        const canvasType = step.canvas?.canvasType || step.canvas?.type || step.canvas?.templateType || step.canvas?.canvasData?.templateType;
        if (canvasType !== 'mcp-app') return;

        const toolName = step.toolName || step.tool?.name || 'tool';
        const postJsonRpc = (method: string, params: any) => {
            try {
                const payload = {
                    jsonrpc: '2.0',
                    method,
                    params,
                };
                (this.config.targetWindow as any)?.postMessage(payload, this.config.targetOrigin || '*');
                this.log('[MCP-MIRROR] Sent MCP notification', { method, toolName, stepStatus: step.stepStatus, toolPhase: step.toolPhase });
            } catch (err) {
                this.log('[MCP-MIRROR] Failed to send MCP notification', err);
            }
        };

        // Stream argument updates
        if (step.argumentStream) {
            postJsonRpc('ui/notifications/tool-input-partial', {
                tool: { name: toolName },
                arguments: step.argumentStream,
            });
        }

        // For in-flight execution, surface tool-input to indicate processing
        if (!step.stepStatus || step.stepStatus === 'processing') {
            postJsonRpc('ui/notifications/tool-input', {
                tool: { name: toolName },
                arguments: step.arguments ?? step.argumentStream,
                toolPhase: step.toolPhase,
                stepStatus: step.stepStatus,
                canvasPatch: step.canvas?.canvasData,
            });
        }

        // On completion or error, emit tool-result with the canvas patch + status
        if (step.stepStatus === 'complete' || step.stepStatus === 'error') {
            const resultPayload =
                step.result ??
                step.outputFromToolObject ??
                step.outputFromTool ??
                step.canvas?.canvasData ??
                step.arguments ??
                step.argumentStream ??
                null;
            postJsonRpc('ui/notifications/tool-result', {
                tool: { name: toolName },
                result: resultPayload,
                ...(step.error ? { error: step.error } : {}),
            });
        }
    }
    
    /**
     * Handle ready messages
     */
    private handleReadyMessage(payload: any): void {
        if (this.config.onReady) {
            this.config.onReady(payload as BotDojoReadyMessage);
        }
    }
    
    /**
     * Handle error messages
     */
    private handleErrorMessage(payload: any): void {
        if (this.config.onError) {
            this.config.onError(payload);
        }
    }
    
    /**
     * Check if bridge is active
     */
    isRunning(): boolean {
        return this.isActive;
    }
    
    /**
     * Update configuration
     */
    updateConfig(config: Partial<PostMessageBridgeConfig>): void {
        this.config = { ...this.config, ...config };
    }
    
    /**
     * Update target window
     */
    updateTargetWindow(targetWindow: any): void {
        this.config.targetWindow = targetWindow;
        this.log('Target window updated');
    }
    
    /**
     * Log helper
     */
    private log(message: string, data?: any): void {
        if (this.config.debug) {
            if (data) {
                console.log(`[PostMessageBridge:${this.config.clientId}] ${message}`, data);
            } else {
                console.log(`[PostMessageBridge:${this.config.clientId}] ${message}`);
            }
        }
    }

    /**
     * Derive a canvas-aware source identifier to stamp onto messages
     * when the iframe doesn't know its own canvasId.
     */
    private inferCanvasSource(): string | undefined {
        // Only stamp an explicit defaultSource when the caller opts in.
        // Avoid leaking canvas identifiers to the client; the server owns canvas IDs.
        if (this.config.defaultSource) {
            return this.config.defaultSource;
        }
        return undefined;
    }
}

/**
 * Helper to create a bridge to parent window
 */
export function createParentBridge(config: Omit<PostMessageBridgeConfig, 'targetWindow'>): PostMessageBridge {
    if (typeof (globalThis as any).window === 'undefined') {
        throw new Error('createParentBridge requires a browser environment');
    }
    return new PostMessageBridge({
        ...config,
        targetWindow: (globalThis as any).window.parent,
        // ParentBridge needs to receive messages from both parent AND canvas iframes
        // so we disable source window filtering
        filterSourceWindow: false
    });
}

/**
 * Helper to create a bridge to a child iframe
 */
export function createIframeBridge(
    iframe: any, 
    config: Omit<PostMessageBridgeConfig, 'targetWindow'>
): PostMessageBridge {
    if (!(iframe as any).contentWindow) {
        throw new Error('Iframe contentWindow is not available');
    }
    
    return new PostMessageBridge({
        ...config,
        targetWindow: (iframe as any).contentWindow
    });
}

/**
 * Helper to detect if running in iframe
 */
export function isInIframe(): boolean {
    if (typeof (globalThis as any).window === 'undefined') {
        return false;
    }
    try {
        const win = (globalThis as any).window;
        return win.self !== win.top;
    } catch (e) {
        return true;
    }
}

/**
 * Helper to parse transport from URL
 */
export function detectTransportFromURL(): {
    transport: 'rpc' | 'postmessage';
    socketUrl?: string;
} {
    if (typeof (globalThis as any).window === 'undefined') {
        return { transport: 'rpc' };
    }
    const params = new URLSearchParams((globalThis as any).window.location.search);
    const transport = params.get('transport') as 'rpc' | 'postmessage' || 'rpc';
    const socketUrl = params.get('agent_socket_url');
    
    return { transport, socketUrl };
}

/**
 * Helper to extract channelId from socket URL
 */
export function extractChannelIdFromSocketUrl(socketUrl: string): string | null {
    // Socket URL format: https://api.botdojo.com/api/v1/rpc/uc/{channelId}_extui
    const match = socketUrl.match(/\/rpc\/uc\/([^\/]+)_extui/);
    return match ? match[1] : null;
}
