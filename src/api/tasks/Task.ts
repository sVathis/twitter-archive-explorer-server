import { Socket } from "socket.io";
import { Worker } from 'worker_threads';
import logger from "../../logger";
import { CONSUMER_KEY, CONSUMER_SECRET } from "../../twitter_const";
import { TweetCounter } from "../../constants";

export interface TaskProgression {
    percentage: number;
    done: number;
    remaining: number;
    failed: number;
    total: number;
    id: string;
    error?: string;
    type: TaskType;
}

interface WorkerTask { 
    type: "task" | "stop", 
    credentials: TwitterCredentials, 
    tweets: string[],
    task_type: TaskType,
}

interface WorkerMessage {
    type: string;
    // SINCE THE LAST MESSAGE
    info?: {
        done: number;
        failed: number;
    };
    error?: any;
}

interface TwitterCredentials {
    consumer_token: string;
    consumer_secret: string;
    oauth_token: string;
    oauth_token_secret: string;
}

interface Credentials {
    user_id: string;
    oauth_token: string;
    oauth_token_secret: string;
    screen_name?: string;
}

export type TaskType = "tweet" | "mute" | "block" | "fav" | "dm";

export function isValidTaskType(type: string) : type is TaskType {
    return type === "tweet" || type === "mute" || type === "block" || type === "fav" || type === "dm";
}

export default class Task {
    protected static current_id = 1n;
    // Key is Task ID
    protected static readonly tasks_to_objects: Map<BigInt, Task> = new Map;
    protected static readonly users_to_tasks: Map<string, Set<Task>> = new Map;
    
    static readonly DEFAULT_THREAD_NUMBER = 2;

    // STATIC METHODS
    static get(id: string | BigInt) {
        if (typeof id === 'string') {
            id = BigInt(id);
        }

        return this.tasks_to_objects.get(id);
    }

    static tasksOf(user_id: string) {
        if (this.users_to_tasks.has(user_id)) {
            return this.users_to_tasks.get(user_id)!;
        }

        return new Set<Task>();
    }

    static typeOf(type: TaskType, user_id: string) {
        const tasks = this.tasksOf(user_id);

        const t = new Set<Task>();

        for (const task of tasks) {
            if (task.type === type) {
                t.add(task);
            }
        }

        return t;
    }

    static get count() {
        return this.tasks_to_objects.size;
    }

    protected static register(task: Task) {
        this.tasks_to_objects.set(task.id, task);

        // USER TASK
        if (!this.users_to_tasks.has(task.owner)) {
            this.users_to_tasks.set(task.owner, new Set);
        }
        this.users_to_tasks.get(task.owner)!.add(task);
    }

    protected static unregister(task: Task) {
        this.tasks_to_objects.delete(task.id);

        // USER TASK
        const tasks = this.users_to_tasks.get(task.owner);
        if (tasks) {
            tasks.delete(task);

            if (!tasks.size) {
                this.users_to_tasks.delete(task.owner);
            }
        }
    }

    // INSTANCE PROPERTIES & METHODS
    
    readonly id: BigInt;

    protected sockets: Set<Socket> = new Set;

    protected pool: Worker[] = [];

    protected done = 0;
    protected remaining = 0;
    protected failed = 0;

    protected last: TaskProgression;

    protected twitter_errors_encountered: { [code: string]: number } = {};

    constructor(
        items_ids: string[],
        protected user: Credentials,
        public readonly type: TaskType,
        thread_number: number = Task.DEFAULT_THREAD_NUMBER,
    ) { 
        // Register the this object for callbacks
        // TODO test
        this.onWorkerMessage = this.onWorkerMessage.bind(this);

        // Auto increment internal ID
        const c = Task.current_id;
        Task.current_id++;
        this.id = c;

        logger.verbose(`Starting task ${c} with ${items_ids.length} items to delete`);

        this.last = {
            id: String(this.id),
            remaining: items_ids.length,
            done: 0,
            failed: 0,
            percentage: 0,
            total: items_ids.length,
            type: this.type
        };

        this.remaining = items_ids.length;

        // Register task
        Task.register(this);

        // Spawn worker thread(s)...
        // Découpage en {thread_number} parties le tableau de tweets
        if (items_ids.length <= thread_number ||items_ids.length < 50) {
            // Si il y a moins d'items que de threads, alors on lance un seul thread (y'en a pas beaucoup)
            // Ou alors si il y a peu d'items
            this.startWorker(items_ids);
        }
        else {
            const part_count = Math.ceil(items_ids.length / thread_number);
            let i = 0;
            let items_ids_part: string[];
    
            while ((items_ids_part = items_ids.slice(i * part_count, (i+1) * part_count)).length) {
                this.startWorker(items_ids_part);
                i++;
            }
        }
    }

    protected startWorker(items: string[]) {
        logger.silly(`Task #${this.id}: Starting worker ${this.pool.length + 1}.`);

        const worker = new Worker(__dirname + '/task_worker/worker.js');
        const task_to_worker: WorkerTask = {
            tweets: items,
            credentials: { 
                consumer_token: CONSUMER_KEY, 
                consumer_secret: CONSUMER_SECRET, 
                oauth_token: this.user.oauth_token, 
                oauth_token_secret: this.user.oauth_token_secret
            },
            type: "task",
            task_type: this.type
        };

        // Assignation des listeners
        worker.on('message', this.onWorkerMessage);

        // Envoi de la tâche quand le worker est prêt
        worker.once('online', () => {
            worker.postMessage(task_to_worker);
        });

        this.pool.push(worker);
    }

    protected onWorkerMessage(data: WorkerMessage) {
        logger.silly("Recieved message from worker:", data);

        if (data.type === "info") {
            // Envoi d'un message de progression de la suppression
            this.done += data.info!.done;

            // Incrémente le compteur si la tâche est de type tweet
            if (this.type === "tweet")
                TweetCounter.inc(data.info!.done);
            
            this.remaining -= (data.info!.done + data.info!.failed);
            this.failed += data.info!.failed;

            this.emitProgress(this.done, this.remaining, this.failed);
        }
        else if (data.type === "end") {
            this.end();
        }
        else if (data.type === "error") {
            this.emitError(data.error);
            // Termine le worker
            this.end(false);
        }
        else if (data.type === "misc") {
            logger.debug("Worker misc data", data);
        }
        else if (data.type === "twitter_error") {
            const error = data.error as number;
            if (error in this.twitter_errors_encountered) {
                this.twitter_errors_encountered[error]++;
            }
            else {
                this.twitter_errors_encountered[error] = 1;
            }
        }
    }

    subscribe(socket: Socket) {
        this.sockets.add(socket);
        socket.emit('progression', this.last);
    }

    unsubscribe(socket: Socket) {
        this.sockets.delete(socket);
    }

    clearSubs() {
        this.sockets.clear();
    }

    cancel() {
        logger.debug("Canceling task", this.id);
        this.sendMessageToSockets('task cancel', {
            id: String(this.id),
            type: this.type
        });

        this.end(false);
    }

    end(with_end_message = true) {
        for (const worker of this.pool) {
            worker.removeAllListeners();
        }

        // Send end message to sockets
        if (with_end_message) {
            this.sendMessageToSockets('task end', {
                id: String(this.id),
                type: this.type
            });
        }

        logger.debug("Terminating workers");
        // Send stop message to workers then terminate
        for (const worker of this.pool) {
            worker.postMessage({ type: 'stop' });
            process.nextTick(() => worker.terminate());
        }

        // Empty pool of workers
        this.pool = [];

        this.clearSubs();

        // Unregister task from Maps
        Task.unregister(this);

        logger.info(`Task #${this.id} has ended. Type ${this.type}, from @${this.user.screen_name}, ${this.done} ok + ${this.failed} failed of ${this.length} (Remaining ${this.remaining})`);
        
        if (this.has_twitter_errors_encountered) {
            logger.warn(`Twitter errors has been encountered: ${
                Object.entries(this.twitter_errors_encountered)
                    .map(([code, count]) => `#${code} (${count})`)
                    .join(', ')
            }`);
        }
    }

    get current_progression() {
        return this.last;
    }

    get owner() {
        return this.user.user_id;
    }

    get length() {
        return this.done + this.remaining + this.failed;
    }

    get has_twitter_errors_encountered() {
        return Object.keys(this.twitter_errors_encountered).length > 0;
    }

    protected emit(progression: TaskProgression) {
        this.last = progression;
        this.sendMessageToSockets('progression', progression);
    }

    protected sendMessageToSockets(name: string, message: any) {
        logger.debug(`Sending message ${name} to all sockets for task ${this.id}`, message);

        for (const s of this.sockets) {
            s.emit(name, message);
        }
    }

    protected emitProgress(done: number, remaining: number, failed: number) {
        const total = done + remaining + failed;

        this.emit({
            done, 
            remaining, 
            id: String(this.id), 
            failed, 
            total, 
            percentage: ((done + failed) / total) * 100,
            type: this.type
        });
    }

    protected emitError(reason = "Unknown error") {
        logger.warn(`Error in worker for task #${this.id}: ${reason}`);
        this.emit({
            done: 0, 
            remaining: 0, 
            id: String(this.id), 
            total: this.length, 
            failed: 0, 
            percentage: 0,
            error: reason,
            type: this.type
        });
    }
}