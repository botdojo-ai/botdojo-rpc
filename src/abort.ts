
import { getBaseChannel, IBotDojoRpcContext, IRPC_Client, RPCMessage } from '.';

/**
 * Cache the crypto module reference at load time to avoid repeated checks
 * This optimization prevents CPU overhead when generateUUID is called frequently
 */
let cachedCryptoRandomUUID: (() => string) | null = null;
try {
	// Try browser crypto API first
	if (typeof crypto !== 'undefined' && crypto.randomUUID) {
		cachedCryptoRandomUUID = () => crypto.randomUUID();
	}
	// Try Node.js crypto module
	else if (typeof require !== 'undefined') {
		const nodeCrypto = require('crypto');
		if (nodeCrypto && nodeCrypto.randomUUID) {
			cachedCryptoRandomUUID = () => nodeCrypto.randomUUID();
		}
	}
} catch (e) {
	// No crypto available, will use Math.random fallback
}

/**
 * Generate a UUID v4 string
 * Works in both browser and Node.js environments
 * Optimized for high-frequency calls with cached crypto reference
 */
function generateUUID(): string {
	// Use cached crypto API if available
	if (cachedCryptoRandomUUID) {
		return cachedCryptoRandomUUID();
	}
	
	// Fallback: Generate UUID v4 using Math.random()
	// Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = Math.random() * 16 | 0;
		const v = c === 'x' ? r : (r & 0x3 | 0x8);
		return v.toString(16);
	});
}

export class AbortRequestMessage {
    type: 'ping' | 'abort' | 'barge-in' | 'hydrate'
    reason: string;
}
export class AbortResponseMessage {
    type: 'pong' | 'aborted' | 'timeout' | 'barged-in' | 'hydrated'
    success: boolean;
    message: string;
    data: any;
}

export class AbortHandle {
    id: string;
    func: (message: AbortRequestMessage) => Promise<AbortResponseMessage>
}
export class AbortHandler {
    _client: IRPC_Client
    aborting: boolean = false;
    bargingIn: boolean = false;
    hydrating: boolean = false
    private parentAbortHandle: AbortHandle = null;
    private parentBargeInHandle: AbortHandle = null;

    async abort(reason: string): Promise<void> {
        this.aborting = true;
        await Promise.all(Object.values(this.abortListeners).map(async (listener) => {
            return  listener.func({
                type: 'abort',
                reason: reason
            });
        }));
    }
    async bargeIn(reason: string): Promise<void> {
        this.bargingIn = true;
        await Promise.allSettled(Object.values(this.bargeInListeners).map(async (listener) => {
            return  listener.func({
                type: 'barge-in',
                reason: reason
            });
        }));
    }
    async hydrate(): Promise<void> {
        this.hydrating = true;
        await Promise.allSettled(Object.values(this.hydrationListeners).map(async (listener) => {
            return await listener.func({
                type: 'hydrate',
                reason: "hydrate"
            });
        }));
        this.hydrating = false;
        return null;
    }
    constructor(public ctx: IBotDojoRpcContext, public channel: string, public parentAbortHandler?: AbortHandler) {
        this.ctx = ctx;
        let me = this;
        this.parentAbortHandle = null;
        this.parentBargeInHandle = null;

        this._client = this.ctx.getRpcProvider().getClient(async () => ctx.getToken(), 'server', '*', getBaseChannel(ctx) + channel);
        this._client.onMessage = async (msg: RPCMessage) => {
            try {
                if (msg.destination == me._client.clientId || me._client.clientId == "*" || msg.destination == "*") {
                    if (msg.direction == 'response') {
                        return;
                    }
                    let data = msg.data as AbortRequestMessage;
                    if (data.type == 'ping') {
                        let pingResponse = new AbortResponseMessage();
                        pingResponse.type = 'pong';
                        pingResponse.success = true;
                        me._client.sendMessage(new RPCMessage(msg.source, '*', 'response', '*', { type: 'pong', success: true, message: '', data: pingResponse }));
                    }
                    else if (data.type == 'barge-in') {
                        try {
                            me.bargingIn = true;
                            await Promise.all(Object.values(me.bargeInListeners).map(async (listener) => {
                                return await listener.func(data);
                            }));
                            me._client.sendMessage(new RPCMessage(msg.source, '*', 'response', '*', { type: 'barged-in', success: true, message: data.reason, data: null }));
                        }
                        catch (e) {
                            console.error(e);
                            this._client.sendMessage(new RPCMessage(msg.source, '*', 'response', '*', { type: 'error', success: false, message: e, data: null }));
                        }
                    }
                    else if (data.type == 'hydrate') {
                        me.hydrating = true;
                        let fr: any;
                        let results = await Promise.all(Object.values(me.hydrationListeners).map(async (listener) => {
                            return await listener.func(data);
                        }));
                        fr = results[0].data as any;
                        me.hydrating = false;
                        me._client.sendMessage(new RPCMessage(msg.source, '*', 'response', '*', { type: 'hydrated', success: true, message: data.reason, data: fr }));
                    }
                    else {
                        try {
                            me.aborting = true;
                            if (data.reason != null && data.reason != "") {
                                me.abortReason = data.reason;
                            }
                            await Promise.all(Object.values(me.abortListeners).map(async (listener) => {
                                return await listener.func(data);
                            }));
                            me._client.sendMessage(new RPCMessage(msg.source, '*', 'response', '*', { type: 'aborted', success: true, message: data.reason, data: null }));
                        }
                        catch (e) {
                            console.error(e);
                            this._client.sendMessage(new RPCMessage(msg.source, '*', 'response', '*', { type: 'error', success: false, message: e, data: null }));
                        }

                    }


                }
                else {
                    console.debug("Ignoring message because for destination ", msg.destination)
                }
            }
            catch (e) {
                console.error(e);
                throw "Error sending Message " + this.channel + " " + e;
            }

        }

    }
    async init() {
        await this._client.init();

        let me = this;
        if (this.parentAbortHandler) {
            this.parentAbortHandle = this.parentAbortHandler.onAbortRequested(async (message) => {
                await this.abort(message.reason);
                return {
                    type: 'aborted',
                    success: true,
                    message: message.reason,
                    data: null
                } as AbortResponseMessage;
            });
            this.parentBargeInHandle = this.parentAbortHandler.onBargeInRequested(async (message) => {
                await me.bargeIn(message.reason);
                return {
                    type: 'barged-in',
                    success: true,
                    message: message.reason,
                    data: null
                } as AbortResponseMessage;
            });
        }
    }
    async close() {
        try {
            if (this.parentAbortHandler) {
                this.parentAbortHandler.stopListening(this.parentAbortHandle);
            }
            if (this.parentBargeInHandle) {
                this.parentAbortHandler.stopListening(this.parentBargeInHandle);
            }
        }
        catch (e) {
            console.error("Error stop listening in AbortHandler:", e);
        }
        await this._client.close();
    }
    private abortListeners: { [id: string]: AbortHandle } = {};
    private bargeInListeners: { [id: string]: AbortHandle } = {};
    private hydrationListeners: { [id: string]: AbortHandle } = {};
    private abortReason: string = "Abort";
    onAbortRequested(func: (message: AbortRequestMessage) => Promise<AbortResponseMessage>): AbortHandle {
        if (this.aborting) {
            throw new Error(this.abortReason);
        }
        let handle = new AbortHandle();
        handle.func = func;
        handle.id = generateUUID();
        this.abortListeners[handle.id] = handle;
        return handle;
    }

    onBargeInRequested(func: (message: AbortRequestMessage) => Promise<AbortResponseMessage>): AbortHandle {
        if (this.bargingIn) {
            func({ type: 'barge-in', reason: 'bargin' });
            return null;
        }

        let handle = new AbortHandle();
        handle.func = func;
        handle.id = generateUUID();
        this.bargeInListeners[handle.id] = handle;
        return handle;
    }
    onRequestHydrationRequested(func: (message: AbortRequestMessage) => Promise<AbortResponseMessage>): AbortHandle {
        let handle = new AbortHandle();
        handle.func = func;
        handle.id = generateUUID();
        this.hydrationListeners[handle.id] = handle;
        return handle;
    }

    stopListening(handle: AbortHandle) {
        delete this.abortListeners[handle.id];
        delete this.bargeInListeners[handle.id];
        delete this.hydrationListeners[handle.id];
    }

}
export interface IAbortSignal {
    onAbortRequested(func: (message: AbortRequestMessage) => Promise<AbortResponseMessage>): void;
}
export class AbortRequestor {
    _client: IRPC_Client
    hasInit: boolean = false;
    _resolve: (value: AbortResponseMessage) => void;
    _reject: (reason?: any) => void;
    constructor(public ctx: IBotDojoRpcContext, public channel: string) {
        this.ctx = ctx;

        this._client = this.ctx.getRpcProvider().getClient(async () => ctx.getToken(), 'client', '*', getBaseChannel(ctx) + channel);

        this._client.onMessage = async (msg: RPCMessage) => {
            try {
                if (msg.destination == this._client.clientId || this._client.clientId == "*" || msg.destination == "*") {
                    if (this._resolve) {
                        this._resolve(msg.data);
                    }
                    // let response = await onMessage(msg.data);
                    //this._client.sendMessage(new RPCMessage(msg.source, 'server', 'response', '*', response));
                }
                else {
                    console.debug("Ignoring message because for destination ", msg.destination)
                }
            }
            catch (e) {
                console.error(e);
                throw "Error sending Message " + this.channel + " " + e;
            }

        }
    }
    async close() {
        try {
            if (this.hasInit) {
                await this._client.close();
                this.hasInit = false;
                this._resolve = null;
                this._reject = null;
            }
        } catch (e) {
            console.error("Error closing AbortRequestor:", e);
        }
    }
    async _sendMessage(message: AbortRequestMessage, timeout: number): Promise<AbortResponseMessage> {
        if (!this.hasInit) {
            await this._client.init();
            this.hasInit = true;
        }
        return new Promise<AbortResponseMessage>(async (resolve, reject) => {
            try {

                let setResponse = false;
                setTimeout(() => {
                    if (!setResponse) {
                        setResponse = true;
                        resolve({ type: 'timeout', success: false, message: "Timeout", data: null });
                    }
                }, timeout);
                this._resolve = (value: AbortResponseMessage) => {
                    if (!setResponse) {
                        setResponse = true;

                        resolve(value);
                    } else {
                        console.debug("Ignoring message because already responded")
                    }
                }
                await this._client.sendMessage(new RPCMessage(this._client.clientId, 'server', 'request', '*', message));
            } catch (e) {
                console.error(e);
                // throw "Error sending Message " + this.channel + " " + e;
                reject(e);
            }
        });
    }
    async sendAbortRequest(reason: string, timeout: number): Promise<AbortResponseMessage> {

        return this._sendMessage({ type: 'abort', reason: reason }, timeout);
    }
    async sendPingRequest(timeout: number): Promise<AbortResponseMessage> {
        return this._sendMessage({ type: 'ping', reason: "Ping" }, timeout);

    }

    async sendBargeInRequest(reason: string, timeout: number): Promise<AbortResponseMessage> {
        console.log("Sending barge in request");
        return this._sendMessage({ type: 'barge-in', reason: reason }, timeout);
    }
    async sendHydrateRequest(timeout: number): Promise<AbortResponseMessage> {
        return this._sendMessage({ type: 'hydrate', reason: "Hydrate" }, timeout);
    }

}
