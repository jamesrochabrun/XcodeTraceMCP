/**
 * RecommendationEngine - Generates actionable optimization recommendations
 */

import { Analysis, Recommendation, Bottleneck } from '../types.js';

/**
 * Pattern-based recommendation rules
 */
interface RecommendationRule {
  pattern: RegExp;
  type: Recommendation['type'];
  priority: Recommendation['priority'];
  title: string;
  descriptionTemplate: string;
  potentialImprovement: string;
  codeExample?: string;
}

const RECOMMENDATION_RULES: RecommendationRule[] = [
  // Image processing
  {
    pattern: /image|bitmap|cgimage|uiimage|resize|scale/i,
    type: 'caching',
    priority: 'high',
    title: 'Implement Image Caching',
    descriptionTemplate: 'Frequent image operations detected. Consider implementing NSCache or disk-based caching to avoid repeated processing.',
    potentialImprovement: '50-70% reduction in image processing time',
    codeExample: `let imageCache = NSCache<NSString, UIImage>()

func cachedImage(for key: String) -> UIImage? {
    if let cached = imageCache.object(forKey: key as NSString) {
        return cached
    }
    let image = processImage(key)
    imageCache.setObject(image, forKey: key as NSString)
    return image
}`,
  },

  // JSON parsing
  {
    pattern: /json|parse|decode|jsonSerialization/i,
    type: 'async',
    priority: 'high',
    title: 'Move JSON Parsing to Background Thread',
    descriptionTemplate: 'JSON parsing is blocking the main thread. Consider using async/await or background queues for parsing.',
    potentialImprovement: 'Improved UI responsiveness',
    codeExample: `Task {
    let data = await fetchData()
    let decoded = try JSONDecoder().decode(Model.self, from: data)
    await MainActor.run {
        updateUI(with: decoded)
    }
}`,
  },

  // Database operations
  {
    pattern: /database|sql|query|fetch|coredata|realm/i,
    type: 'optimization',
    priority: 'high',
    title: 'Optimize Database Queries',
    descriptionTemplate: 'Database operations are taking significant time. Consider adding indexes, batching queries, or using query optimization techniques.',
    potentialImprovement: '40-60% faster queries',
    codeExample: `// Add index
entity.index(on: \\.propertyName)

// Batch fetching
let request = NSFetchRequest<Entity>(entityName: "Entity")
request.fetchBatchSize = 20`,
  },

  // Network operations
  {
    pattern: /network|http|request|url|download|upload/i,
    type: 'caching',
    priority: 'medium',
    title: 'Implement Response Caching',
    descriptionTemplate: 'Frequent network requests detected. Consider implementing request caching or batching multiple requests.',
    potentialImprovement: 'Reduced network calls and faster response times',
  },

  // Sorting/filtering
  {
    pattern: /sort|filter|search|find/i,
    type: 'algorithm',
    priority: 'medium',
    title: 'Optimize Collection Operations',
    descriptionTemplate: 'Frequent collection operations detected. Consider using more efficient algorithms or pre-computed indexes.',
    potentialImprovement: '30-50% faster operations',
    codeExample: `// Use Set for O(1) lookups instead of Array.contains
let idSet = Set(ids)
let filtered = items.filter { idSet.contains($0.id) }`,
  },

  // View layout
  {
    pattern: /layout|constraint|autolayout|updateConstraints|layoutSubviews/i,
    type: 'optimization',
    priority: 'medium',
    title: 'Simplify View Hierarchy',
    descriptionTemplate: 'Auto Layout is consuming significant time. Consider simplifying view hierarchy or using manual layout for performance-critical views.',
    potentialImprovement: 'Faster view updates and animations',
  },

  // Cryptography
  {
    pattern: /crypto|encrypt|decrypt|hash|hmac|aes/i,
    type: 'async',
    priority: 'high',
    title: 'Move Cryptographic Operations Off Main Thread',
    descriptionTemplate: 'Cryptographic operations are blocking. These should always run on background threads.',
    potentialImprovement: 'Improved UI responsiveness',
  },

  // File I/O
  {
    pattern: /file|read|write|fileManager|document/i,
    type: 'async',
    priority: 'high',
    title: 'Perform File I/O Asynchronously',
    descriptionTemplate: 'File operations are blocking the main thread. Use async I/O or background queues.',
    potentialImprovement: 'Non-blocking I/O operations',
  },
];

/**
 * Generates optimization recommendations from analysis
 */
export class RecommendationEngine {
  /**
   * Generate recommendations for an analysis
   */
  generateRecommendations(analysis: Analysis): Recommendation[] {
    const recommendations: Recommendation[] = [];

    // Generate recommendations from bottlenecks
    for (const bottleneck of analysis.bottlenecks) {
      const recommendation = this.generateRecommendationForBottleneck(bottleneck);
      if (recommendation) {
        recommendations.push(recommendation);
      }
    }

    // Add general recommendations based on stats
    recommendations.push(...this.generateGeneralRecommendations(analysis));

    // Remove duplicates and prioritize
    return this.deduplicateAndPrioritize(recommendations);
  }

  /**
   * Generate recommendation for a specific bottleneck
   */
  private generateRecommendationForBottleneck(bottleneck: Bottleneck): Recommendation | null {
    const functionName = `${bottleneck.module || ''}${bottleneck.function}`;

    // Try to match against patterns
    for (const rule of RECOMMENDATION_RULES) {
      if (rule.pattern.test(functionName)) {
        return {
          type: rule.type,
          priority: this.adjustPriority(rule.priority, bottleneck.impact),
          title: rule.title,
          description: rule.descriptionTemplate,
          affectedFunctions: [bottleneck.function],
          potentialImprovement: rule.potentialImprovement || `~${bottleneck.duration.toFixed(0)}ms`,
          codeExample: rule.codeExample,
        };
      }
    }

    // Generic recommendation if no pattern matches
    if (bottleneck.impact === 'critical' || bottleneck.impact === 'high') {
      return {
        type: 'optimization',
        priority: bottleneck.impact === 'critical' ? 'high' : 'medium',
        title: `Optimize ${bottleneck.function}`,
        description: bottleneck.suggestion,
        affectedFunctions: [bottleneck.function],
        potentialImprovement: `~${bottleneck.duration.toFixed(0)}ms (${bottleneck.percentage.toFixed(1)}% of total time)`,
      };
    }

    return null;
  }

  /**
   * Generate general recommendations based on overall stats
   */
  private generateGeneralRecommendations(analysis: Analysis): Recommendation[] {
    const recommendations: Recommendation[] = [];

    // Too many slow functions
    if (analysis.stats.slowFunctions > 10) {
      recommendations.push({
        type: 'architecture',
        priority: 'medium',
        title: 'Consider Architectural Refactoring',
        description: `Found ${analysis.stats.slowFunctions} slow functions. This suggests the need for broader architectural improvements rather than individual function optimizations.`,
        affectedFunctions: [],
        potentialImprovement: 'Overall better performance and maintainability',
      });
    }

    // High thread contention (many threads but poor performance)
    if (analysis.stats.threadCount > 8 && analysis.stats.avgFunctionTime > 100) {
      recommendations.push({
        type: 'architecture',
        priority: 'medium',
        title: 'Review Thread Management',
        description: `High thread count (${analysis.stats.threadCount}) but slow performance suggests thread contention or over-parallelization. Consider reducing concurrent operations.`,
        affectedFunctions: [],
        potentialImprovement: 'Reduced thread contention and context switching',
      });
    }

    return recommendations;
  }

  /**
   * Adjust priority based on bottleneck impact
   */
  private adjustPriority(
    basePriority: Recommendation['priority'],
    impact: Bottleneck['impact']
  ): Recommendation['priority'] {
    if (impact === 'critical') {
      return 'high';
    }
    if (impact === 'high' && basePriority === 'medium') {
      return 'high';
    }
    if (impact === 'low' && basePriority === 'high') {
      return 'medium';
    }
    return basePriority;
  }

  /**
   * Remove duplicate recommendations and prioritize
   */
  private deduplicateAndPrioritize(recommendations: Recommendation[]): Recommendation[] {
    // Use title as deduplication key
    const seen = new Map<string, Recommendation>();

    for (const rec of recommendations) {
      const existing = seen.get(rec.title);
      if (!existing) {
        seen.set(rec.title, rec);
      } else {
        // Merge affected functions
        const combined = {
          ...existing,
          affectedFunctions: [...new Set([...existing.affectedFunctions, ...rec.affectedFunctions])],
        };
        seen.set(rec.title, combined);
      }
    }

    // Sort by priority
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return Array.from(seen.values()).sort(
      (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]
    );
  }
}

/**
 * Convenience function to generate recommendations
 */
export function generateRecommendations(analysis: Analysis): Recommendation[] {
  const engine = new RecommendationEngine();
  return engine.generateRecommendations(analysis);
}
