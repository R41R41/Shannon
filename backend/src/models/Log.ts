import { ILog } from '@shannon/common';
import mongoose from 'mongoose';

const LogSchema = new mongoose.Schema<ILog>({
  timestamp: { type: Date, required: true },
  memoryZone: { type: String, required: true },
  color: { type: String, required: true },
  content: { type: String, required: true },
  sessionId: { type: String, required: false },
});

export default mongoose.model<ILog>('Log', LogSchema);
