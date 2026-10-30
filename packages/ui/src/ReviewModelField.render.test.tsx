/**
 * The project form's Review model field (F16.13): that it renders under its label, that the
 * empty choice names the model it defers to, and what a chosen option means as a stored value.
 * `ProjectForm` itself has no test harness here, so the field is rendered on its own with
 * `renderToStaticMarkup`, as the other render tests in this package are.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TransportProvider, type Transport } from './transport';
import { ReviewModelField, reviewModelFromOption, SAME_AS_PLANNING } from './ReviewModelField';

const stubTransport: Transport = {
  invoke: () => Promise.resolve(undefined) as never,
  on: () => () => {},
  pathForFile: () => '',
};

function render(value: 'opus' | null): string {
  return renderToStaticMarkup(
    <TransportProvider transport={stubTransport}>
      <ReviewModelField
        label="Review model"
        value={value}
        planningModel="opus"
        onChange={() => {}}
      />
    </TransportProvider>,
  );
}

describe('ReviewModelField', () => {
  it('renders under its label, naming the planning model it defers to', () => {
    const html = render(null);
    expect(html).toContain('Review model');
    expect(html).toContain('Same as planning (opus)');
  });

  it('maps the sentinel and an empty Dropdown to null, a model to itself', () => {
    expect(reviewModelFromOption(SAME_AS_PLANNING)).toBeNull();
    expect(reviewModelFromOption(undefined)).toBeNull();
    expect(reviewModelFromOption('haiku')).toBe('haiku');
  });
});
