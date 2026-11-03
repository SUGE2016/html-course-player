const slides = [
  {title:'函数与测试',html:'<p class="lead">把一个任务写成函数，再用测试说明它的行为。</p><div class="equation"><span>输入参数</span><b>→</b><span>函数</span><b>→</b><span>返回结果</span></div>'},
  {title:'一个求和函数',html:'<pre><code class="language-python">def add(a, b):\n    return a + b\n\nprint(add(2, 3))  # 5</code></pre><p>参数 a、b 提供输入；return 返回计算结果。</p>'},
  {title:'用测试描述预期',html:'<pre><code class="language-python">assert add(2, 3) == 5\nassert add(-2, 2) == 0\nassert add(0, 0) == 0</code></pre><p>分别检查一般情况、正负数相抵和零值。</p>'}
];
