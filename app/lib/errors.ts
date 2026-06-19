export class BackendError extends Error {
	status: number;

	constructor(message: string, status = 400) {
		super(message);
		this.name = "BackendError";
		this.status = status;
	}
}

