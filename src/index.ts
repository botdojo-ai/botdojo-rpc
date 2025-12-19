
/**
 * Generate a UUID v4. Uses crypto.randomUUID() if available, otherwise falls back to Math.random()
 * This ensures compatibility across all environments without requiring external dependencies.
 */
export function generateUUID(): string {
	if (typeof crypto !== 'undefined' && crypto.randomUUID) {
		return crypto.randomUUID();
	}
	// Fallback: Generate UUID v4 using Math.random()
	// Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = Math.random() * 16 | 0;
		const v = c === 'x' ? r : (r & 0x3 | 0x8);
		return v.toString(16);
	});
}
export class ConectionOptions {
	timeout?: number = 30000;
	maxDepth?: number = 18;
}

export class RPCMessageError {
	_type = "MessageError";
	message: string;
	constructor(public error: any) {
		if (typeof error == "string") {
			this.message = error;
		} else if (error.message) {
			this.message = error.message;
		} else {
			this.message = error.toString();
		}
	}
	toString() {
		return this.message;
	}
}
export class CallbackHandlerMethods {
	source: any;
	func: any;
}
function getProps(obj: any) {
	var p = [];
	for (; obj != null; obj = Object.getPrototypeOf(obj)) {
		var op = Object.getOwnPropertyNames(obj);
		for (var i = 0; i < op.length; i++)
			//@ts-ignore
			if (p.indexOf(op[i]) == -1) {
				//@ts-ignore
				p.push(op[i]);
			}
	}
	return p;
}
export function getPropertyNames(obj) {
	const ignores = [
		"__defineGetter__",
		"__defineSetter__",
		"__lookupGetter__",
		"__lookupSetter__",
		"__proto__",
		"constructor",
		"hasOwnProperty",
		"isPrototypeOf",
		"propertyIsEnumerable",
		"toLocaleString",
		"toString",
		"valueOf",
	];
	const props = [];
	const seen = [];
	while (obj != null) {
		if (seen.includes(obj)) {
			break;
		}
		seen.push(obj);
		const current = getProps(obj); // Object.getOwnPropertyNames(obj);
		const filtered = current.filter((item) => {
			if (ignores.includes(item) || props.includes(item)) {
				return false;
			}
			return true;
		});
		if (current.length > 0 && filtered.length === 0) {
			break;
		}
		props.push(...filtered);
		if (obj.prototype) {
			obj = obj.prototype;
		} else if (obj.constructor && obj.constructor.prototype) {
			obj = obj.constructor.prototype;
		} else {
			break;
		}
		if(obj)
		{
			//get parameters of the function
			let parameters = obj.prototype?.constructor?.parameters;
			if(parameters)
			{
				props.push(...parameters);
			}	
		}
	}
	props.sort();
	return props;
}

export function getRequestProxyObject(
	id: string,
	sender: IRPC_Client,
	callbacks: Map<string, CallbackHandlerMethods>,
	source: any,
	depth: number,
	maxDepth: number,
) {
	//let retval = {};
	//check if source is an array
	if (Array.isArray(source)) {
		let arrRetVal = new Array<any>();
		source.forEach((item, index) => {
			arrRetVal.push(
				getRequestProxyObject(
					id + "." + index,
					sender,
					callbacks,
					item,
					depth + 1,
					maxDepth,
				),
			);
		});
		return arrRetVal;
	}
	if (typeof source == "object") {
		let retval = {};
		getPropertyNames(source).forEach((i) => {
			let prop = source[i];
			//check it is a function
			if (typeof prop == "function") {
				retval[i] = {
					___function: id + "." + i,
				};

				callbacks.set(id + "." + i, { source: source, func: prop });
			}
			// check type of object
			else if (typeof prop == "object" || Array.isArray(prop)) {
				if (depth <= 99) {
					retval[i] = getRequestProxyObject(
						id + "." + i,
						sender,
						callbacks,
						prop,
						depth + 1,
						maxDepth,
					);
				} else {
					retval[i] = prop;
				}
			} else {
				retval[i] = source[i];
			}
		});
		if(Object.keys(retval).length == 0)
		{
			return null;
		}
		return retval;
	} else if (typeof source == "function") {
		throw new Error("root can't be a function");
	} else {
		return source;
	}
	//return retval;
}

export function getReceivedProxyObject(
	connection: RPCConnection,
	destination: string,
	callbacks: Map<string, CallbackHandlerMethods>,
	source: any,
) {
	
	let retval = {};
	if (Array.isArray(source)) {
		let arrRetVal = new Array<any>();
		source.forEach((item, index) => {
			arrRetVal.push(
				getReceivedProxyObject(connection, destination, callbacks, item),
			);
		});
		return arrRetVal;
	}
	if (typeof source == "object") {
		getPropertyNames(source).forEach((i) => {
			let prop = 	source[i];
			if (!prop) {
				retval[i] = source[i];
			} else if (prop.___function) {
				retval[i] = async (...args): Promise<any> => {
					console.log("sending request " + prop.___function);
					return new Promise(async (resolve, reject) => {
						try {
							let arr = Array.from(args);
							let d = await connection.sendRequest(
								destination,
								prop.___function,
								arr,
							);
							if (d?._type == "MessageError") {
								return reject(d);
							}
							resolve(d);
						} catch (e) {
							reject(e);
						}
					});
				};
			} else if (typeof prop == "object" || Array.isArray(prop)) {
				retval[i] = getReceivedProxyObject(
					connection,
					destination,
					callbacks,
					prop,
				);
			} else {
				retval[i] = source[i];
			}
		});
	} else if (typeof source == "function") {
		throw new Error("root can't be a function");
	} else {
		retval = source;
	}
	return retval;
}

export class RPCMessage {
	id: string;
	source: string;
	destination: string;
	direction: "request" | "response";
	functionName: string;
	data: any;
	sendOnlyIfThereIsAListener?: boolean = false;
	host_id: string;
	/** Origin of the PostMessage (for CORS validation) */
	origin?: string;
	static request(
		source: string,
		destination: string,
		functionName: string,
		data: any,
	) {
		return new RPCMessage(source, destination, "request", functionName, data);
	}
	static response(msg: RPCMessage, data: any) {
		let newMessage = new RPCMessage(
			msg.destination,
			msg.source,
			"response",
			msg.functionName,
			data,
		);
		newMessage.id = msg.id;
		return newMessage;
	}
	constructor(
		source: string,
		destination: string,
		direction: "request" | "response",
		functionName: string,
		data: any,
	) {
		if (source == destination)
			throw new Error("source and destination can't be the same");
		this.source = source;
		this.data = data;
		this.direction = direction;
		this.destination = destination;
		this.id = generateUUID();
		this.functionName = functionName;
		this.host_id = "notset"
	}
}

export class RegisterRPCClient {
	getToken: () => Promise<string>;
	clientId: string;
	defaultDestinationId: string;
	baseChannel: string; // May not be needed if using namespaces
	onConnectionStatusChange?: (status: 'connected' | 'disconnected' | 'reconnecting' | 'reconnect_failed', reason?: string) => void;
}

export interface IRPCMessageServerBroadcaster{
	sendMessage(channel:string,message: RPCMessage): Promise<any>;
}
export interface IRPC_Client{
	clientId: string;
	defaultDestinationId: string;
	onMessage: (message: RPCMessage) => Promise<void>;
	onConnectionStatusChange?: (status: 'connected' | 'disconnected' | 'reconnecting' | 'reconnect_failed', reason?: string) => void;
	init(): Promise<void>;
	close(): Promise<void>;
	sendMessage(message: RPCMessage): Promise<any>;
}

export class RPCConnection {
	callbacks: Map<string, CallbackHandlerMethods> = new Map<
		string,
		CallbackHandlerMethods
	>();
	onMessage: (msg: RPCMessage) => Promise<any>;
	constructor(
		public sender: IRPC_Client,
		public options: ConectionOptions,
		onMessage?: (msg: RPCMessage) => Promise<any>,
	) {
		this.options = options ?? new ConectionOptions();

		if (!onMessage) {
			this.onMessage = async (msg: RPCMessage): Promise<any> => {
				return new RPCMessageError("Unknown function " + msg.functionName);
			};
		} else {
			this.onMessage = onMessage;
		}
		sender.onMessage = this.incommingMessage.bind(this);
	}
	log(msg: string, data?: any, data2?: any) {
		console.log(this.sender.clientId, msg, data, data2);
	}
	async init() {
		await this.sender.init();
	}
	close() {
		this.callbacks.clear();
		// Break the circular reference between RPCConnection and sender
		if (this.sender) {
			this.sender.onMessage = undefined; 
		}
		this.sender.close();
	}
	async sendRequestToHost(
		functionName: string,
		data: Array<any> | any,
	): Promise<any> {
		return this.sendRequest(
			this.sender.defaultDestinationId,
			functionName,
			data,
		);
	}
	
	
	async sendRequest(
		destinationId: string,
		functionName: string,
		data: Array<any> | any,
		timeoutMs?:number
	): Promise<any> {
		return new Promise(async (resolve, reject) => {
			try {
				let sendData = Array.isArray(data) ? data : [data];

				let responseSent = false;
				let requestId = generateUUID();
				this.callbacks.set(requestId, {
					source: this.sender,
					func: (...args) => {
						
						if (responseSent) {
							console.warn("Response already sent for " + functionName);
							return;
						}
						responseSent = true;
						if (args[0]?._type == "MessageError") {
							reject(args[0]);
							return;
						}
						resolve(args[0]);
					},
				});
				let proxyObject = getRequestProxyObject(
					generateUUID(),
					this.sender,
					this.callbacks,
					sendData,
					0,
					this.options.maxDepth,
				);

				setTimeout(() => {
					if(!responseSent)
					{
						responseSent = true;
						reject(new RPCMessageError("Timeout waiting for response from " + destinationId + " for " + functionName));
					}
				},
					timeoutMs??this.options?.timeout ?? 30000,
				);


				
				let msg = new RPCMessage(
					this.sender.clientId,
					destinationId,
					"request",
					functionName,
					proxyObject,
				);
				msg.id = requestId;
			
				await this.sender.sendMessage(msg);
			} catch (e) {
				reject(e);
			}
		});
	}
	incommingMessage(msg: RPCMessage) {
		let direction = msg.direction == "request" ? " request >>" : " response <<";

		console.debug(
			this.sender.clientId + ":Incomming Message " + this.sender.clientId,
			direction,
			msg.source,
			msg.functionName,
		);
		if (msg.destination == this.sender.clientId || msg.destination == "*") {
			let log = (output: any, err: any) => {
				if (err) {
					console.error("## Request " + msg.functionName + " error", err, "##");
				} else {
					console.debug(
						"## Request " + msg.functionName + " output",
						JSON.stringify(output, null, 2),
						"##",
					);
				}
			};

			msg.data = getReceivedProxyObject(
				this,
				msg.source,
				this.callbacks,
				msg.data,
			);
			if (msg.direction == "request") {
				let cb = this.callbacks.get(msg.functionName);
				if (cb) {
						;
					//this.callbacks.delete(msg.functionName);
					let promise = cb.func.apply(cb.source, msg.data);
					if (promise && promise.then) {
						promise
							.then((response) => {
								log(response, null);
								this.sender.sendMessage(
									RPCMessage.response(
										msg,
										getRequestProxyObject(
											generateUUID(),
											this.sender,
											this.callbacks,
											response,
											0,
											this.options.maxDepth,
										),
									),
								);
							})
							.catch((e) => {
								log(null, e);
								this.sender.sendMessage(
									RPCMessage.response(msg, new RPCMessageError(e)),
								);
							});
					} else {
						log(promise, null);
						this.sender.sendMessage(
							RPCMessage.response(
								msg,
								getRequestProxyObject(
									generateUUID(),
									this.sender,
									this.callbacks,
									promise,
									0,
									this.options.maxDepth,
								),
							),
						);
					}
					return;
				}
				this.onMessage(msg)
					.then((response) => {
						this.sender.sendMessage(
							RPCMessage.response(
								msg,
								getRequestProxyObject(
									generateUUID(),
									this.sender,
									this.callbacks,
									response,
									0,
									this.options.maxDepth,
								),
							),
						);
					})
					.catch((e) => {
						this.sender.sendMessage(
							RPCMessage.response(msg, new RPCMessageError(e)),
						);
					});
			} else {
				// this.log("incomming response",msg.functionName,msg.data)
				let cb = this.callbacks.get(msg.id);
			this.callbacks.delete(msg.id);
				if (cb) {
					cb.func.call(cb.func, msg.data);

					return;
				} else {
					console.warn(
						this.sender.clientId + "no callback for response",
						msg.functionName,
						msg.data,
					);
				}
			}
		} else {
			console.warn(
				this.sender.clientId +
					":Incomming Message IGNORE " +
					this.sender.clientId,
				direction,
				msg.source,
				msg.functionName,
			);
		}
	}
}

export interface IGetRPCProviders {
	getClient(registerSender: RegisterRPCClient): IRPC_Client;
	getServerBroadcaster(): IRPCMessageServerBroadcaster;
}

export * from "./rpcProvider";
export * from "./abort";
export * from "./PostMessageBridge";
export * from "./PostMessageRPCClient";
