import { BaseProvider } from './BaseProvider.js';
import OpenAIProvider from './OpenAIProvider.js';
import RetellAIProvider from './RetellAIProvider.js';
import SarvamProvider from './SarvamProvider.js';
import PipecatProvider from './PipecatProvider.js';
import LiveKitProvider from './LiveKitProvider.js';
// import VAPIProvider from './VAPIProvider.js';

export type ProviderType = 'openai' | 'retellai' | 'vapi' | 'sarvam' | 'pipecat' | 'livekit';

class ProviderFactory {
  private static instances: Map<ProviderType, BaseProvider> = new Map();

  static getProvider(type: ProviderType): BaseProvider {
    if (!this.instances.has(type)) {
      switch (type) {
        case 'openai':
          this.instances.set(type, new OpenAIProvider());
          break;
        case 'retellai':
          this.instances.set(type, new RetellAIProvider());
          break;
        case 'sarvam':
          this.instances.set(type, new SarvamProvider());
          break;
        case 'pipecat':
          this.instances.set(type, new PipecatProvider());
          break;
        case 'livekit':
          this.instances.set(type, new LiveKitProvider());
          break;
        case 'vapi':
          // this.instances.set(type, new VAPIProvider());
          throw new Error('VAPI provider not yet implemented');
        default:
          throw new Error(`Unknown provider type: ${type}`);
      }
    }

    return this.instances.get(type)!;
  }

  static getAvailableProviders(): ProviderType[] {
    return ['openai', 'retellai', 'sarvam', 'pipecat', 'livekit'];
  }
}

export default ProviderFactory;