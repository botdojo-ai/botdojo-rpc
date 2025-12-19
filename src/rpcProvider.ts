import {
	IGetRPCProviders,
	IRPCMessageServerBroadcaster,
	IRPC_Client,
	RPCConnection,
	RPCMessage,
	RPCMessageError,
} from "./index";

export class HostParams {
	serviceId: string;
	version: string;
	functions: Map<string, Function> = new Map<string, Function>();
}
export class SessionParams {
	moduleId: string;
}
export class RegisterRemoteServiceResult {
	token: string;
	clientId: string;
	hostId: string;
	baseChannel: string;
}
export class RegisterParams {
	serviceId: string;
	version: string;
	functions: Map<string, Function> = new Map<string, Function>();
}
export class ClientOptions {
	timeout: number;
}

export class ListenHandler {
	constructor(public onMessage: (msg: RPCMessage) => Promise<any>) { }
}
export function getBaseChannel(ctx: IBotDojoRpcContext) {
    return `/rpc/${ctx.getAccountId()}/${ctx.getProjectId()}/`;
}
export interface IBotDojoRpcContext{
    getToken: () => Promise<string>;
    getAccountId: () => string;
    getProjectId: () => string;
    getRpcProvider: () => IRPCProvider;

}

export interface IRPCProvider {
	setCtx(ctx: IBotDojoRpcContext): void;

	getClient(
		getToken: () => Promise<string>,
		clientId: string,
		hostId: string,
		baseChannel: string,
	): IRPC_Client;
	getConnectionToFunctionCall(channel: string, senderId: string, receiverId: string, onMessage: (msg: RPCMessage) => Promise<any>): Promise<RPCConnection>
	getChannelListener(channel: string): ChannelListener;
	getChannelBroadcaster(): IRPCMessageServerBroadcaster;
}

function getRpcPath(ctx: IBotDojoRpcContext, namespace: string, accountScope: boolean = false) {
	if (accountScope) {
		return `/rpc/${ctx.getAccountId()}/${namespace}`;

	}
	return `/rpc/${ctx.getAccountId()}/${ctx.getProjectId()}/${namespace}`;
}
export class ChannelListener {
	constructor(
		public ctx: IBotDojoRpcContext,
		public namespace: string,
		public accountScope: boolean = false,
	) {
		this.ctx = ctx;
		this.namespace = namespace;
	}
	connection: IRPC_Client;
	async listen(callback: (data: any) => void) {
		if (!this.connection) {
			this.connection = this.ctx.getRpcProvider().getClient(
				async () => this.ctx.getToken(),
				"listener",
				"host",
				getRpcPath(this.ctx, this.namespace, this.accountScope),
			);
		}
		this.connection.onMessage = async (msg: RPCMessage) => {
			callback(msg.data);
		};
		await this.connection.init();
	}
	async stop() {
		if (this.connection) {
			await this.connection.close();
		}
	}
}
export class ChannelBroadcaster {
	connection: IRPC_Client;
	constructor(
		public ctx: IBotDojoRpcContext,
		public namespace: string,
		public accountScope: boolean = false,
	) {
		this.ctx = ctx;
		this.namespace = namespace;
	}

	buffer: any[] = []
	connecting: boolean = false
	private inflightCount: number = 0
	private async waitForDrain(): Promise<void> {
		while (this.inflightCount > 0 || this.buffer.length > 0 || this.connecting) {
			await new Promise((r) => setTimeout(r, 1));
		}
	}
	async _send(data: any) {
		let msg = new RPCMessage(
			this.connection.clientId,
			this.connection.defaultDestinationId,
			"request",
			"emitToAll",
			data,
		);
		await this.connection.sendMessage(msg);
	}
	async emitToAll(data: any): Promise<void> {
		try {
			if (!this.connection) {
				this.connecting = true
				this.buffer.push(data)
				this.connection = this.ctx.getRpcProvider().getClient(
					async () => this.ctx.getToken(),
					"broadcastor",
					"listener",
					getRpcPath(this.ctx, this.namespace, this.accountScope),
				);

				await this.connection.init();

				while (this.buffer.length > 0) {
					let d = this.buffer.shift()
					try {
						this.inflightCount++;
						await this._send(d)
					} catch (e) {
						throw e;
					} finally {
						this.inflightCount--;
					}
				}

				this.connecting = false
				this.buffer = []
				return;
			}
			if (this.connecting) {
				this.buffer.push(data)
				return
			}
			this.inflightCount++;
			await this._send(data)
		} catch (e) {
			console.error(e);
			this.connecting = false
			throw "Error sending Message " + this.namespace + " " + e;
		} finally {
			if (this.inflightCount > 0) {
				this.inflightCount--;
			}
		}
	}
	async close(timeoutMs: number = 1000) {
		let drained = false;
		let drainPromise = this.waitForDrain().then(() => { drained = true; });
		await Promise.race([
			drainPromise,
			new Promise((resolve) => setTimeout(resolve, timeoutMs))
		]);
		if (this.connection) {
			await this.connection.close();
		}
	}

	closeAsync(delayMs: number = 0, timeoutMs: number = 1000): void {
		// For reasons that aren't completely understood to me, we require two sets of setImmediate/setTimeout to ensure that onFlowRequestEnd events are processed.
		// I assume that there are two async awaits in prior sendMessage calls that we need to ensure are completed.
		setImmediate(() => {
			setTimeout(() => {
				this.close(timeoutMs);
			}, delayMs);
		});
	}
}

export type BackendJobControlMessageCommandTypes = "request-ping" | "request-abort" |
	'response-abort' | 'response-pong' | 'response-error'
export class BackendJobControlMessage {
	time: Date = new Date();
	constructor(public to: string, public from: string, public message: BackendJobControlMessageCommandTypes, public text: string, public errorMessage: string, public data: any) {
	}
}


export class RPCProvider implements IRPCProvider {
	ctx: IBotDojoRpcContext;
	async getConnectionToFunctionCall(channel: string, senderId: string, receiverId: string, onMessage: (msg: RPCMessage) => Promise<any>): Promise<RPCConnection> {
		let c = '/rpc/uc/' + channel;
		let connection = new RPCConnection(
			this.getClient(
				async () => senderId,
				senderId,
				receiverId,
				c,
			),
			null,
			onMessage,
		);
		await connection.init();
		return connection;
	}
	
	

	getClient(
		getToken: () => Promise<string>,
		clientId: string,
		defaultDestinationId: string,
		baseChannel: string,
	): IRPC_Client {
		return this.getRPCProviders.getClient({
			getToken: getToken,
			clientId: clientId,
			defaultDestinationId: defaultDestinationId,
			baseChannel: baseChannel,
		});
	}
	constructor(public getRPCProviders: IGetRPCProviders) { }
	setCtx(ctx: IBotDojoRpcContext) {
		this.ctx = ctx;
	}

	getChannelListener(channel: string): ChannelListener {
		return new ChannelListener(this.ctx, channel, false);
	}


	getChannelBroadcaster(): IRPCMessageServerBroadcaster {
		let broadcaster = this.getRPCProviders.getServerBroadcaster();
		return broadcaster;
	}
}