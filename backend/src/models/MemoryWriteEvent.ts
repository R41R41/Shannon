import mongoose, { Schema, Types } from 'mongoose';

export interface IMemoryWriteEventExchange {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface IMemoryWriteEvent {
  _id: Types.ObjectId;
  eventId: string;
  sourceRequestId: string;
  channel: string;
  conversationId: string;
  threadId: string;
  sourceUserId: string;
  payload: {
    envelope: Record<string, unknown>;
    conversationText: string;
    exchanges: IMemoryWriteEventExchange[];
  };
  status: 'pending' | 'processing' | 'processed' | 'error';
  errorMessage?: string;
  createdAt: Date;
  processedAt?: Date;
}

const ExchangeSchema = new Schema<IMemoryWriteEventExchange>(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, required: true },
  },
  { _id: false },
);

const MemoryWriteEventSchema = new Schema<IMemoryWriteEvent>({
  eventId: { type: String, required: true, unique: true },
  sourceRequestId: { type: String, required: true, index: true },
  channel: { type: String, required: true, index: true },
  conversationId: { type: String, required: true, index: true },
  threadId: { type: String, required: true, index: true },
  sourceUserId: { type: String, required: true, index: true },
  payload: {
    envelope: { type: Schema.Types.Mixed, required: true },
    conversationText: { type: String, required: true },
    exchanges: { type: [ExchangeSchema], default: [] },
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'processed', 'error'],
    default: 'pending',
    index: true,
  },
  errorMessage: { type: String },
  createdAt: { type: Date, default: Date.now, index: true },
  processedAt: { type: Date },
});

MemoryWriteEventSchema.index({ status: 1, createdAt: 1 });

export const MemoryWriteEvent = mongoose.model<IMemoryWriteEvent>(
  'MemoryWriteEvent',
  MemoryWriteEventSchema,
);
